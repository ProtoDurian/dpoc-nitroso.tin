// AppDb — the Postgres app library under test (spike F1-F3).
// Reads ALL credential parts (host, port, user, password, database) from a secret file (a mounted Secret),
// hot-reloads it, builds a new pool generation on change, and HOLDS+RETRIES writes while the DB is fenced.
//
// Behaviours (this is the spec the report quotes):
//  B1 secret file is polled; a changed content = new generation: new pool, old pool drained and closed.
//  B2 every pool has maxLifetimeSeconds (connections age out even without a secret change).
//  B3 write gate: first "write unavailable" error (25006 read_only_sql_transaction, 57P01/57P02/57P03, 08*, 53300,
//     ECONNRESET/ECONNREFUSED/EPIPE/ETIMEDOUT, "terminated", 28P01/28000 auth failure) closes the gate; ALL later
//     writes wait on it (no retry storm); ONE prober checks a FRESH connection every probeMs until the server accepts
//     writes (transaction_read_only = off) or a new secret generation appears; then the gate opens and waiters retry.
//  B4 reads never wait on the gate (a fenced source still serves reads); they retry only connection-level errors.
//  B5 a write is retried automatically only if it is idempotent (carries an idempotency key / is a single
//     statement with ON CONFLICT) or the error is "definitely not executed" (25006, connect-time errors).
//     Non-idempotent write + ambiguous error (reset after send) => surfaced as failure (or retried, policy 'retryAmbiguous').
//  B6 hold deadline holdMaxMs per op (policy fence.maxSeconds); beyond it the op fails with HoldTimeout.
//  B7 28P01 (bad password) re-reads the secret immediately and treats it as write-unavailable (credentials rotate).
import pg from "pg";
import { readFileSync } from "node:fs";

export type Secret = { host: string; port: number; user: string; password: string; database: string; ssl?: boolean };
const sslOf = (s: Secret) => (s.ssl ? { rejectUnauthorized: false, servername: s.host } : undefined);
export type OpOpts = { idempotent?: boolean; retryAmbiguous?: boolean };
export type Stats = { gateClosedAt: number[]; gateOpenedAt: number[]; generations: { at: number; user: string; host: string; port: number }[] };

const DEFINITE_NOT_EXECUTED = new Set(["25006", "57P03", "53300", "28P01", "28000"]); // plus connect-phase errors
const CONN_CODES = new Set(["ECONNRESET", "ECONNREFUSED", "EPIPE", "ETIMEDOUT", "ENOTFOUND", "EAI_AGAIN"]);

function classify(e: any): { retry: boolean; definite: boolean; kind: string } {
  const code: string = e?.code ?? "";
  if (code === "25006") return { retry: true, definite: true, kind: "readonly" };
  if (code === "28P01" || code === "28000") return { retry: true, definite: true, kind: "auth" };
  if (DEFINITE_NOT_EXECUTED.has(code)) return { retry: true, definite: true, kind: code };
  if (code === "57P01" || code === "57P02") return { retry: true, definite: false, kind: "terminated" };
  if (code.startsWith("08")) return { retry: true, definite: false, kind: "conn" };
  if (code === "40001" || code === "40P01") return { retry: true, definite: true, kind: "serialization" };
  if (CONN_CODES.has(code)) return { retry: true, definite: code === "ECONNREFUSED" || code === "ENOTFOUND", kind: code };
  const m = String(e?.message ?? "");
  if (/Connection terminated|terminating connection|timeout exceeded when trying to connect|Client has encountered a connection error|read ECONNRESET|socket hang up|the database system is (starting up|shutting down)|connection timeout/i.test(m))
    return { retry: true, definite: /timeout exceeded when trying to connect/.test(m), kind: "conn" };
  return { retry: false, definite: false, kind: "other" };
}

export class HoldTimeout extends Error {}

export class AppDb {
  private pool!: pg.Pool;
  private raw = "";
  private cur!: Secret;
  private old: pg.Pool[] = [];
  private timer?: any;
  private gate: Promise<void> | null = null;
  private openGate: (() => void) | null = null;
  private gen = 0;
  readonly stats: Stats = { gateClosedAt: [], gateOpenedAt: [], generations: [] };
  constructor(private secretPath: string, private o: { max?: number; holdMaxMs?: number; pollMs?: number; probeMs?: number; maxLifetimeSeconds?: number; naive?: boolean; retryOnly?: { tries: number; backoffMs: number } } = {}) {}

  start() { this.load(true); this.timer = setInterval(() => this.load(false), this.o.pollMs ?? 100); }
  async stop() { clearInterval(this.timer); await Promise.allSettled([this.pool?.end(), ...this.old.map((p) => p.end())]); }
  get secret() { return this.cur; }

  private load(first: boolean) {
    let raw: string;
    try { raw = readFileSync(this.secretPath, "utf8"); } catch { return; } // transient (atomic rename) -> keep current
    if (raw === this.raw) return;
    const s: Secret = JSON.parse(raw);
    const prev = this.pool;
    this.raw = raw; this.cur = s; this.gen++;
    this.pool = new pg.Pool({
      host: s.host, port: s.port, user: s.user, password: s.password, database: s.database, ssl: sslOf(s),
      max: this.o.max ?? 40, connectionTimeoutMillis: 10000, idleTimeoutMillis: 30000,
      maxLifetimeSeconds: this.o.maxLifetimeSeconds ?? 300, allowExitOnIdle: false,
    });
    this.pool.on("error", () => {});
    this.pool.on("connect", (c) => c.on("error", () => {})); // checked-out client killed by server: the query rejects, do not crash // idle client killed by server (terminate, fence): ignore, next checkout reconnects
    this.stats.generations.push({ at: Date.now(), user: s.user, host: s.host, port: s.port });
    if (!first && prev) { this.old.push(prev); setTimeout(() => { prev.end().catch(() => {}); this.old = this.old.filter((p) => p !== prev); }, 15000); }
    if (this.gate) this.openGateNow(); // new generation: let waiters retry at once
  }

  private closeGate() {
    if (this.gate) return;
    this.gate = new Promise<void>((r) => (this.openGate = r));
    this.stats.gateClosedAt.push(Date.now());
    this.prober();
  }
  private openGateNow() {
    if (!this.gate) return;
    const r = this.openGate!; this.gate = null; this.openGate = null;
    this.stats.gateOpenedAt.push(Date.now());
    r();
  }
  private async prober() {
    const probeMs = this.o.probeMs ?? 50;
    while (this.gate) {
      const gen = this.gen, s = this.cur;
      const c = new pg.Client({ host: s.host, port: s.port, user: s.user, password: s.password, database: s.database, ssl: sslOf(s), connectionTimeoutMillis: 5000 });
      c.on("error", () => {});
      try {
        await c.connect();
        const r = await c.query("select current_setting('transaction_read_only') ro, pg_is_in_recovery() rec");
        if (r.rows[0].ro === "off" && !r.rows[0].rec) { this.openGateNow(); }
      } catch (e: any) {
        if (classify(e).kind === "auth") this.load(false); // B7 re-read secret
      } finally { c.end().catch(() => {}); }
      if (gen !== this.gen) { this.openGateNow(); }
      if (this.gate) await Bun.sleep(probeMs);
    }
  }

  /** run fn with a checked-out client. write=true goes through the gate. */
  async run<T>(fn: (c: pg.PoolClient) => Promise<T>, write: boolean, op: OpOpts = {}): Promise<{ v: T; retries: number; heldMs: number; kinds: string[] }> {
    const t0 = Date.now(), deadline = t0 + (this.o.holdMaxMs ?? 30000);
    let retries = 0, heldMs = 0; const kinds: string[] = [];
    for (;;) {
      if (write && !this.o.naive && !this.o.retryOnly && this.gate) {
        const h = Date.now();
        await Promise.race([this.gate, Bun.sleep(Math.max(0, deadline - Date.now())).then(() => { throw new HoldTimeout("hold deadline"); })]);
        heldMs += Date.now() - h;
      }
      let client: pg.PoolClient | undefined;
      try {
        client = await this.pool.connect();
        const v = await fn(client);
        client.release();
        return { v, retries, heldMs, kinds };
      } catch (e: any) {
        if (client) client.release(e); // destroy the connection on any error
        if (this.o.naive) throw e;
        if (this.o.retryOnly) { const k0 = classify(e); if (!k0.retry || retries >= this.o.retryOnly.tries) throw e; retries++; kinds.push(k0.kind); if (k0.kind === "auth") this.load(false); await Bun.sleep(this.o.retryOnly.backoffMs); continue; }
        const k = classify(e);
        if (!k.retry) throw e;
        if (write && !k.definite && !op.idempotent && !op.retryAmbiguous) throw e; // B5
        if (Date.now() > deadline) throw new HoldTimeout(`hold deadline after ${retries} retries (${k.kind})`);
        retries++; kinds.push(k.kind);
        if (write && (k.kind === "readonly" || k.kind === "auth" || k.kind === "conn" || k.kind === "terminated" || k.kind === "ECONNREFUSED" || k.kind === "ECONNRESET")) {
          if (k.kind === "auth") this.load(false);
          this.closeGate();
        } else await Bun.sleep(Math.min(250, 20 * 2 ** Math.min(retries, 4)) * (0.5 + Math.random()));
      }
    }
  }
  write<T>(fn: (c: pg.PoolClient) => Promise<T>, op: OpOpts = {}) { return this.run(fn, true, op); }
  read<T>(fn: (c: pg.PoolClient) => Promise<T>) { return this.run(fn, false); }
}
