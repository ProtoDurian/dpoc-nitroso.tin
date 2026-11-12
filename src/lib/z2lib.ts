// Z2 library for Bun: "hold, drain, switch" around the ordinary `pg` client (pg.Pool). See ../SPEC2.md.
// It only: (1) holds NEW write work while the gate is closed, (2) counts in-flight write units, (3) acks,
// (4) points new work at the address in the control doc. It never retries a write, never batches callers
// together, never adds keys. Errors from the database go to the caller unchanged.
import pg from "pg";
import { readFileSync, writeFileSync, renameSync, mkdirSync } from "node:fs";

export type DbAddr = { host: string; port: number; user: string; password: string; database: string; ssl?: boolean };
export type Doc = { gen: number; hold: boolean; db: DbAddr };
export type Cfg = {
  id: number | string; lang?: string; mode?: "live" | "swap" | "plain";
  control?: string; ackDir?: string; ctlPort?: number; writePool?: number; readPool?: number; holdMaxMs?: number;
  connectTimeoutMs?: number; // pg connect timeout AND max wait for a free pool connection (default 30000)
  legacySecret?: string; // upgrade only: old flat Secret until the first control document exists
};
export type Ack = { id: number | string; gen: number; hold: boolean; drained: boolean; inflight: number; waiting: number; host: string; port: number; database: string; pid: number; at: number };
export class HoldTimeout extends Error { code = "HOLD_TIMEOUT"; constructor(ms: number) { super(`hold deadline ${ms} ms passed before the write could start`); } }

class Deque<T> {
  a: T[] = []; h = 0;
  get length() { return this.a.length - this.h; }
  push(x: T) { this.a.push(x); }
  peek() { return this.a[this.h]; }
  shift() { const x = this.a[this.h]; this.a[this.h++] = undefined as any; if (this.h > 65536 && this.h * 2 > this.a.length) { this.a = this.a.slice(this.h); this.h = 0; } return x; }
}

// ---- what is "write work"? (SPEC2 section 1)
const qtext = (q: any): string => (typeof q === "string" ? q : q?.text ?? "");
const stripLead = (s: string) => s.replace(/^(?:\s+|--[^\n]*\n?|\/\*[\s\S]*?\*\/)+/, "");
export function isRead(sql: string): boolean {
  const s = stripLead(sql);
  if (/;\s*\S/.test(s.replace(/'(?:[^']|'')*'/g, "''"))) return false; // several statements in one text: treat as a write
  if (/^(select|show|values|table)\b/i.test(s)) return true; // an autocommit SELECT (even FOR UPDATE) changes no data
  if (/^with\b/i.test(s)) return !/\b(insert|update|delete|merge)\b/i.test(s); // WITH ... SELECT only
  if (/^explain\b/i.test(s)) return !/\banalyze\b/i.test(s);
  return false;
}
const BEGIN_RE = /^\s*(begin|start\s+transaction)\b/i;
const END_RE = /^\s*(commit|rollback|end|abort)\b(?!\s+(to\b|prepared\b))/i;

function retryableConn(e: any): boolean { // for READS only (a plain SELECT is safe to repeat)
  const code: string = e?.code ?? "";
  if (code.startsWith("08") || ["57P01", "57P02", "57P03", "53300", "28P01", "28000"].includes(code)) return true;
  if (["ECONNRESET", "ECONNREFUSED", "EPIPE", "ETIMEDOUT", "EAI_AGAIN"].includes(code)) return true;
  return /Connection terminated|terminating connection|timeout exceeded when trying to connect|Client has encountered a connection error|ECONNRESET|socket hang up|database system is (starting up|shutting down)|connection timeout|Client was closed|too many clients/i.test(String(e?.message ?? ""));
}
const sick = (e: any) => !/^[0-9A-Z]{5}$/.test(String(e?.code ?? "")); // connection-level error: destroy the connection

class Gen {
  wpool: pg.Pool; rpool: pg.Pool; units = 0; retired = false; closed = false; timer?: any;
  constructor(public addr: DbAddr, o: { app: string; wmax: number; rmax: number; ct: number }) {
    const mk = (max: number) => {
      const p = new pg.Pool({ host: addr.host, port: addr.port, user: addr.user, password: addr.password, database: addr.database, ssl: addr.ssl ? { rejectUnauthorized: false } : undefined, application_name: o.app, max, connectionTimeoutMillis: o.ct, idleTimeoutMillis: 60000 });
      p.on("error", () => {}); p.on("connect", (c) => c.on("error", () => {}));
      return p;
    };
    this.wpool = mk(o.wmax); this.rpool = mk(o.rmax);
  }
  end() { if (this.closed) return Promise.resolve(); this.closed = true; clearTimeout(this.timer); return Promise.allSettled([this.wpool.end(), this.rpool.end()]); }
}

type Waiter = { res: (g: Gen) => void; rej: (e: any) => void; deadline: number };

export class Z2Db {
  readonly cfg: Required<Pick<Cfg, "id" | "writePool" | "readPool" | "holdMaxMs">> & Cfg;
  private mode: "live" | "swap" | "plain";
  private cur!: Gen; private curKey = ""; private raw = ""; private appliedGen = -1; private holdFlag = false; private closed = false;
  private inflight = 0; private waitQ = new Deque<Waiter>(); private lastDrained = false;
  private timer?: any; private tick = 0; private server?: any; private gens: Gen[] = [];
  readonly st = { gens: [] as { gen: number; at: number; host: string; port: number; hold: boolean }[], drainedAt: [] as { gen: number; at: number }[], holdTimeouts: 0, maxWaiting: 0, maxInflight: 0 };

  constructor(cfg: Cfg) {
    this.cfg = { writePool: 32, readPool: 16, holdMaxMs: 60000, ...cfg } as any;
    this.mode = cfg.mode ?? "live";
  }

  // ---------- public API
  /** Autocommit statement. Reads run at once on the current server; everything else is write work (gated). */
  async query(q: string | { text: string; values?: any[] }, params?: any[]): Promise<pg.QueryResult<any>> {
    if (isRead(qtext(q))) return this.runRead(q, params);
    const g = this.closedGate() ? await this.waitGate() : this.startUnit();
    try { return await g.wpool.query(q as any, params); } finally { this.finishUnit(g); }
  }
  /** Explicit read (never held). Re-run on connection errors (max 20 tries, 5-25 ms apart). */
  read(q: string | { text: string; values?: any[] }, params?: any[]) { return this.runRead(q, params); }
  /** BEGIN is gated; statements inside never; COMMIT at the end, ROLLBACK if fn throws. */
  async begin<T>(fn: (tx: { query: (q: any, params?: any[]) => Promise<pg.QueryResult<any>> }) => Promise<T>): Promise<T> {
    const g = this.closedGate() ? await this.waitGate() : this.startUnit();
    let c: pg.PoolClient | undefined, destroy: any;
    try {
      c = await g.wpool.connect();
      try { await c.query("BEGIN"); } catch (e) { if (sick(e)) destroy = e; throw e; }
      let r: T;
      try { r = await fn({ query: (q, p) => c!.query(q, p) }); }
      catch (e) { try { await c.query("ROLLBACK"); } catch (e2) { destroy = e2; } throw e; }
      try { await c.query("COMMIT"); } catch (e) { destroy = e; throw e; }
      return r;
    } finally { try { c?.release(destroy); } catch {} this.finishUnit(g); }
  }
  /** pg-style client: `const c = await db.connect(); await c.query('BEGIN') ... c.release()`. The physical connection is taken
   *  at BEGIN (after the gate) from the CURRENT server and given back at COMMIT/ROLLBACK, so an idle client follows a switch. */
  async connect(): Promise<Z2Client> { return new Z2Client(this); }

  get stats() { return { inflight: this.inflight, waiting: this.waitQ.length, gate: this.closedGate() ? "closed" : "open", gen: this.appliedGen, holdTimeouts: this.st.holdTimeouts }; }
  get ackNow(): Ack { return this.ack(); }
  get address(): DbAddr | undefined { return this.cur?.addr; }

  async close() {
    this.closed = true; clearInterval(this.timer); try { this.server?.stop(true); } catch {}
    while (this.waitQ.length) this.waitQ.shift().rej(new Error("z2 closed"));
    this.writeAck();
    await Promise.allSettled(this.gens.map((g) => g.end()));
  }

  // ---------- internals used by Z2Client
  /** @internal */ _closedGate() { return this.closedGate(); }
  /** @internal */ _gateOrStart() { return this.closedGate() ? this.waitGate() : this.startUnit(); }
  /** @internal */ _finish(g: Gen) { this.finishUnit(g); }
  /** @internal */ _read(q: any, p?: any[]) { return this.runRead(q, p); }

  private closedGate() { return this.mode === "live" && this.holdFlag; }
  private startUnit(): Gen { const g = this.cur; g.units++; this.inflight++; if (this.inflight > this.st.maxInflight) this.st.maxInflight = this.inflight; return g; }
  private waitGate(): Promise<Gen> {
    return new Promise((res, rej) => { this.waitQ.push({ res, rej, deadline: Date.now() + this.cfg.holdMaxMs }); if (this.waitQ.length > this.st.maxWaiting) this.st.maxWaiting = this.waitQ.length; });
  }
  private finishUnit(g: Gen) {
    this.inflight--; this.useDone(g);
    if (this.closedGate() && this.inflight === 0) this.checkDrained();
  }
  private useDone(g: Gen) { g.units--; if (g.retired && g.units === 0) void g.end(); }
  private async runRead(q: any, params?: any[]): Promise<pg.QueryResult<any>> {
    for (let i = 0; ; i++) {
      const g = this.cur; g.units++;
      try { return await g.rpool.query(q, params); }
      catch (e) { if (i >= 19 || !retryableConn(e)) throw e; }
      finally { this.useDone(g); }
      await Bun.sleep(5 + Math.random() * 20); // next try re-reads this.cur: a read that raced a switch lands on the new server
    }
  }

  // ---------- control doc
  /** Start: read the control doc FIRST; if none is readable, wait (connect nowhere). */
  async start() {
    if (this.mode === "plain" && process.env.DATABASE_HOST) {
      const e = process.env;
      this.applyDoc({ gen: 0, hold: false, db: { host: e.DATABASE_HOST!, port: Number(e.DATABASE_PORT ?? 5432), user: e.DATABASE_USER!, password: e.DATABASE_PASSWORD ?? "", database: e.DATABASE_NAME ?? "postgres", ssl: /^(1|true|on)$/i.test(e.DATABASE_SSL ?? "") } });
    }
    while (!this.cur && !this.closed) { this.poll(); if (!this.cur) await Bun.sleep(20); }
    if (this.closed) return;
    if (this.mode !== "plain") {
      this.timer = setInterval(() => this.onTick(), 20);
      if (this.cfg.ctlPort) this.server = Bun.serve({ port: this.cfg.ctlPort, hostname: "0.0.0.0", fetch: (r) => this.http(r) });
    }
  }
  private onTick() {
    this.poll(); this.sweep();
    if (++this.tick % 12 === 0) this.writeAck(); // 12 x 20 ms = 240 ms
  }
  private poll() {
    if (!this.cfg.control) return;
    let raw: string;
    try { raw = readFileSync(this.cfg.control, "utf8"); }
    catch {
      if (!this.cfg.legacySecret) return;
      try {
        const s = JSON.parse(readFileSync(this.cfg.legacySecret, "utf8"));
        raw = JSON.stringify({ gen: s.generation ?? 0, hold: false, db: { ...s, host: s.directHost ?? s.host } });
      } catch { return; }
    }
    if (raw === this.raw) return;
    let d: any; try { d = JSON.parse(raw); } catch { return; } // half-written / garbage: ignore, try again next poll
    this.raw = raw; this.applyDoc(d);
  }
  private validDoc(d: any): d is Doc {
    return d && typeof d.gen === "number" && typeof d.hold === "boolean" && d.db && typeof d.db.host === "string" && d.db.port != null && typeof d.db.user === "string" && typeof d.db.database === "string";
  }
  private applyDoc(d: any): boolean {
    if (!this.validDoc(d)) return false;
    if (this.appliedGen >= 0 && d.gen <= this.appliedGen) return false; // lower gen ignored, same gen no-op
    const a = d.db as DbAddr;
    const key = JSON.stringify([a.host, Number(a.port), a.user, a.password ?? "", a.database, !!a.ssl]);
    if (key !== this.curKey) {
      const old = this.cur;
      const g = new Gen({ ...a, port: Number(a.port) }, { app: `${this.cfg.lang ?? "bun"}-${this.cfg.id}`, wmax: this.cfg.writePool, rmax: this.cfg.readPool, ct: this.cfg.connectTimeoutMs ?? 30000 });
      this.cur = g; this.curKey = key; this.gens.push(g);
      if (old) this.retire(old);
    }
    const wasClosed = this.closedGate();
    this.holdFlag = d.hold && this.mode === "live";
    this.appliedGen = d.gen;
    this.st.gens.push({ gen: d.gen, at: Date.now(), host: a.host, port: Number(a.port), hold: d.hold });
    this.lastDrained = false;
    if (wasClosed && !this.holdFlag) { // open the gate: FIFO, on the CURRENT pool; inflight counted now so `drained` can never flicker
      const t = Date.now();
      while (this.waitQ.length) { const w = this.waitQ.shift(); if (w.deadline <= t) { this.st.holdTimeouts++; w.rej(new HoldTimeout(this.cfg.holdMaxMs)); } else w.res(this.startUnit()); }
    }
    this.checkDrained(true);
    return true;
  }
  private retire(g: Gen) {
    g.retired = true;
    if (g.units === 0) void g.end();
    else g.timer = setTimeout(() => void g.end(), 30000); // pg Pool.end() is graceful: busy connections close when released
  }
  private sweep() { // hold deadline: FIFO == deadline order
    if (!this.waitQ.length) return;
    const now = Date.now();
    while (this.waitQ.length && this.waitQ.peek().deadline <= now) { const w = this.waitQ.shift(); this.st.holdTimeouts++; w.rej(new HoldTimeout(this.cfg.holdMaxMs)); }
  }
  private checkDrained(force = false) {
    const d = this.closedGate() && this.inflight === 0;
    const changed = d !== this.lastDrained;
    if (d && changed) this.st.drainedAt.push({ gen: this.appliedGen, at: Date.now() });
    this.lastDrained = d;
    if (changed || force) this.writeAck();
  }
  private ack(): Ack {
    const a = this.cur?.addr;
    return { id: this.cfg.id, gen: this.appliedGen, hold: this.closedGate(), drained: this.closedGate() && this.inflight === 0, inflight: this.inflight, waiting: this.waitQ.length, host: a?.host ?? "", port: a?.port ?? 0, database: a?.database ?? "", pid: process.pid, at: Date.now() };
  }
  private writeAck() {
    if (!this.cfg.ackDir) return;
    try {
      mkdirSync(this.cfg.ackDir, { recursive: true });
      const f = `${this.cfg.ackDir}/ack-${this.cfg.id}.json`, t = `${f}.tmp`;
      writeFileSync(t, JSON.stringify(this.ack())); renameSync(t, f);
    } catch {}
  }
  private async http(r: Request): Promise<Response> {
    const u = new URL(r.url);
    if (u.pathname !== "/dbctl") return new Response("not found", { status: 404 });
    if (r.method === "POST") {
      let d: any; try { d = await r.json(); } catch { return new Response("bad json", { status: 400 }); }
      if (!this.validDoc(d)) return new Response("bad doc", { status: 400 });
      this.applyDoc(d);
    } else if (r.method !== "GET") return new Response("method", { status: 405 });
    return Response.json(this.ack());
  }
}

/** pg-style client with lazy physical connection (see Z2Db.connect). */
export class Z2Client {
  private phys?: pg.PoolClient; private g?: Gen; private inTx = false;
  constructor(private db: Z2Db) {}
  async query(q: any, params?: any[]): Promise<pg.QueryResult<any>> {
    const text = qtext(q);
    if (this.inTx) {
      const ending = END_RE.test(text);
      try { const r = await this.phys!.query(q, params); if (ending) this.finish(undefined); return r; }
      catch (e) { if (ending || sick(e)) this.finish(sick(e) ? e : undefined); throw e; }
    }
    if (END_RE.test(text)) return { command: "ROLLBACK", rowCount: null, oid: 0, rows: [], fields: [] } as any; // no open tx here (it died): nothing to end
    if (BEGIN_RE.test(text)) {
      const g = await this.db._gateOrStart(); this.g = g; this.inTx = true;
      try { this.phys = await g.wpool.connect(); return await this.phys.query(q, params); }
      catch (e) { this.finish(sick(e) ? e : undefined); throw e; }
    }
    if (isRead(text)) return this.db._read(q, params);
    return this.db.query(q, params); // autocommit write: gated, runs on the current server
  }
  release(err?: any) { if (this.inTx) this.finish(err ?? true); }
  private finish(destroy: any) {
    if (!this.inTx) return;
    this.inTx = false; const p = this.phys, g = this.g!; this.phys = undefined; this.g = undefined;
    try { p?.release(destroy); } catch {}
    this.db._finish(g);
  }
}

export const Z2 = { async open(cfg: Cfg): Promise<Z2Db> { const d = new Z2Db(cfg); await d.start(); return d; } };
