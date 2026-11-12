// dpoc-nitroso.tin — the notes API (PLAN §5).
//   GET  /healthz        200 (503 while draining)          — no auth
//   GET  /api/info       {cluster, landscape, version}     — no auth
//   GET  /api/whoami     {sub, cluster}                    — Bearer (audience https://tin.nitroso.dpoc)
//   POST /api/notes      {id, cluster}                     — Bearer; Idempotency-Key header = row id
//   GET  /api/notes/:id  the note                           — Bearer
// Every response carries x-dpoc-cluster. SIGTERM: readiness 503, keep serving 10 s, exit.
// Dependencies come ONLY from /deps/<class>-<module>/secret.json (POLLED, swapped on
// generation change, never restarting the pod). Missing dependency => /healthz still 200,
// dependency-dependent routes answer 503 {"error":"dependency <module> not ready"}.
import pkg from "../package.json";
import { Deps } from "./deps.ts";
import { Auth, AuthUnavailableError } from "./auth.ts";

const PORT = Number(process.env.PORT ?? 3000);
const CLUSTER = process.env.DPOC_CLUSTER ?? "local";
const LANDSCAPE = process.env.DPOC_LANDSCAPE ?? "local";
const VERSION = process.env.DPOC_VERSION ?? pkg.version;
const AUDIENCE = "https://tin.nitroso.dpoc";
const DRAIN_MS = 10000;

const log = (evt: string, extra: Record<string, unknown> = {}) =>
  console.log(JSON.stringify({ ts: new Date().toISOString(), evt, cluster: CLUSTER, ...extra }));

if (!process.env.DPOC_ISSUER) {
  console.error("DPOC_ISSUER env is required (https://lithium.aldehyde.<landscape>.<root>/oidc)");
  process.exit(1);
}
const auth = new Auth(process.env.DPOC_ISSUER, AUDIENCE);
const deps = new Deps();

// ---- schema (idempotent, created at start, retried with backoff until the DB answers) ----
let schemaReady = false;
let ensuring: Promise<void> | null = null;
let ensureWaitMs = 1000;
async function ensureSchema() {
  if (schemaReady || ensuring || !deps.db.secret) return;
  ensuring = (async () => {
    try {
      await deps.db.write(
        (c) => c.query(`CREATE TABLE IF NOT EXISTS notes(id text primary key, text text, cluster text, created_at timestamptz default now())`),
        { idempotent: true },
      );
      schemaReady = true;
      ensureWaitMs = 1000;
      log("schema-ready");
    } catch (e) {
      log("schema-retry", { err: String(e), waitMs: ensureWaitMs });
      ensureWaitMs = Math.min(ensureWaitMs * 2, 10000);
    } finally {
      ensuring = null;
    }
  })();
}

/** module that the notes API is still missing, or null when ready. */
function depMissing(): string | null {
  const m = deps.missing();
  if (m) return m;
  if (!schemaReady) return "main";
  return null;
}

// ---- helpers ----
type Json = Record<string, unknown>;
let draining = false;

function corsHeaders(req: Request): Record<string, string> {
  const origin = req.headers.get("origin") ?? "";
  if (!origin || !/\.dpoc\.specpenguin\.dev$/.test(new URL(origin).hostname)) return {};
  return {
    "access-control-allow-origin": origin,
    "access-control-expose-headers": "x-dpoc-cluster, x-dpoc-writes",
    vary: "Origin",
  };
}

function json(req: Request, status: number, body: Json, extra: Record<string, string> = {}): Response {
  const h: Record<string, string> = {
    "content-type": "application/json",
    "x-dpoc-cluster": CLUSTER,
    ...corsHeaders(req),
    ...extra,
  };
  if (draining) h["connection"] = "close";
  return new Response(JSON.stringify(body), { status, headers: h });
}

async function bearer(req: Request): Promise<{ sub: string } | Response> {
  const t = req.headers.get("authorization") ?? "";
  if (!/^Bearer /.test(t)) return json(req, 401, { error: "missing bearer token" });
  try {
    const payload = await auth.verify(t.slice(7));
    return { sub: String(payload.sub) };
  } catch (e) {
    if (e instanceof AuthUnavailableError) return json(req, 503, { error: "auth unavailable" });
    return json(req, 401, { error: "invalid token" });
  }
}

// ---- routes ----
async function route(req: Request): Promise<Response> {
  const u = new URL(req.url);
  const path = u.pathname;
  const method = req.method;

  if (method === "OPTIONS") {
    const cors = corsHeaders(req);
    if (!Object.keys(cors).length) return new Response(null, { status: 204 });
    return new Response(null, {
      status: 204,
      headers: {
        ...cors,
        "access-control-allow-methods": "GET, POST, OPTIONS",
        "access-control-allow-headers": "authorization, content-type, idempotency-key",
        "access-control-max-age": "600",
      },
    });
  }

  if (path === "/healthz") {
    return draining ? json(req, 503, { ok: false, draining: true }) : json(req, 200, { ok: true });
  }

  if (path === "/api/info") {
    return json(req, 200, { cluster: CLUSTER, landscape: LANDSCAPE, version: VERSION });
  }

  if (path === "/api/whoami") {
    const a = await bearer(req);
    if (a instanceof Response) return a;
    return json(req, 200, { sub: a.sub, cluster: CLUSTER });
  }

  if (path === "/api/notes" && method === "POST") {
    const miss = depMissing();
    if (miss) return json(req, 503, { error: `dependency ${miss} not ready` });
    const a = await bearer(req);
    if (a instanceof Response) return a;

    let text: string;
    try {
      const body = (await req.json()) as { text?: unknown };
      text = String(body.text ?? "");
    } catch {
      return json(req, 400, { error: "body must be JSON {text}" });
    }
    if (!text.trim()) return json(req, 400, { error: "text is required" });
    if (text.length > 10000) return json(req, 400, { error: "text too long" });

    const id = req.headers.get("idempotency-key") || crypto.randomUUID();

    await deps.db.write(
      (c) => c.query(`INSERT INTO notes(id, text, cluster) VALUES ($1, $2, $3) ON CONFLICT (id) DO NOTHING`, [id, text, CLUSTER]),
      { idempotent: true },
    );
    const row = await deps.db.read((c) => c.query(`SELECT id, text, cluster, created_at FROM notes WHERE id = $1`, [id]));
    const note = row.v.rows[0] as { id: string; text: string; cluster: string; created_at: Date } | undefined;
    if (!note) return json(req, 500, { error: "note vanished after write" });

    // side effects: PG is the record of truth; kv/store/email failures are logged + flagged
    let kv = "ok", store = "ok";
    try {
      await deps.kv.incr("notes:count");
    } catch (e) {
      kv = "err";
      log("kv-error", { err: String(e) });
    }
    try {
      await deps.store.putObject(`notes/${id}`, JSON.stringify({ ...note, created_at: new Date(note.created_at).toISOString() }));
    } catch (e) {
      store = "err";
      log("store-error", { err: String(e) });
    }
    try {
      deps.email.send({ to: a.sub, subject: "note created", text: id });
    } catch (e) {
      log("email-error", { err: String(e) });
    }

    return json(req, 200, { id: note.id, cluster: note.cluster }, { "x-dpoc-writes": `pg=ok,kv=${kv},store=${store}` });
  }

  if (path === "/api/notes" && method === "GET") {
    // collection GET is not part of the contract, but a fresh landscape must be quiet:
    // the dependency gate answers before the 405.
    const miss = depMissing();
    if (miss) return json(req, 503, { error: `dependency ${miss} not ready` });
    return json(req, 405, { error: "method not allowed" });
  }

  const mNote = /^\/api\/notes\/([^/]+)$/.exec(path);
  if (mNote && method === "GET") {
    const miss = depMissing();
    if (miss) return json(req, 503, { error: `dependency ${miss} not ready` });
    const a = await bearer(req);
    if (a instanceof Response) return a;

    const row = await deps.db.read((c) => c.query(`SELECT id, text, cluster, created_at FROM notes WHERE id = $1`, [decodeURIComponent(mNote[1])]));
    const note = row.v.rows[0] as { id: string; text: string; cluster: string; created_at: Date } | undefined;
    if (!note) return json(req, 404, { error: "not found" });
    return json(req, 200, { id: note.id, text: note.text, cluster: note.cluster, created_at: new Date(note.created_at).toISOString() });
  }

  return json(req, 404, { error: "not found" });
}

// ---- serve ----
deps.start();
auth.start();
setInterval(ensureSchema, 2000);
ensureSchema();

const server = Bun.serve({
  port: PORT,
  fetch(req) {
    const t0 = Date.now();
    return route(req)
      .then((r) => {
        log("http", { method: req.method, path: new URL(req.url).pathname, status: r.status, ms: Date.now() - t0 });
        return r;
      })
      .catch((e) => {
        log("http-error", { method: req.method, path: new URL(req.url).pathname, err: String(e) });
        return json(req, 500, { error: "internal" });
      });
  },
});
log("listening", { port: PORT, landscape: LANDSCAPE, version: VERSION, issuer: process.env.DPOC_ISSUER });

// ---- graceful drain (spike F6 recipe; numbers per H2) ----
function shutdown(sig: string) {
  if (draining) return;
  draining = true;
  log("draining", { sig, serveMs: DRAIN_MS });
  const hard = setTimeout(() => process.exit(0), DRAIN_MS + 5000);
  setTimeout(async () => {
    try {
      server.stop(); // stop accepting; in-flight requests finish
      await deps.stop();
      auth.stop();
    } finally {
      process.exit(0);
    }
  }, DRAIN_MS);
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
