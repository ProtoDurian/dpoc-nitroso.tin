// tests for the JWT check with a FAKE JWKS served by a local http server.
import { describe, test, expect, afterAll } from "bun:test";
import { generateKeyPair, exportJWK, SignJWT } from "jose";
import { Auth, AuthUnavailableError } from "./auth.ts";

const ISSUER_BASE = "http://127.0.0.1:46111/oidc";
const AUD = "https://tin.nitroso.dpoc";

let currentJwks: { keys: any[] } = { keys: [] };
let server: ReturnType<typeof Bun.serve> | null = null;

function startJwks() {
  server = Bun.serve({
    port: 46111,
    fetch(req) {
      if (new URL(req.url).pathname === "/oidc/jwks") return Response.json(currentJwks);
      return new Response("not found", { status: 404 });
    },
  });
}
function stopJwks() {
  server?.stop(true);
  server = null;
}
afterAll(stopJwks);

async function newKey(kid: string) {
  const { publicKey, privateKey } = await generateKeyPair("RS256");
  const jwk = { ...(await exportJWK(publicKey)), kid, alg: "RS256", use: "sig" };
  return { jwk, privateKey };
}
async function mint(priv: CryptoKey, kid: string, sub: string, opts: { aud?: string; iss?: string } = {}) {
  return new SignJWT({ sub })
    .setProtectedHeader({ alg: "RS256", kid })
    .setIssuer(opts.iss ?? ISSUER_BASE)
    .setAudience(opts.aud ?? AUD)
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(priv);
}

describe("Auth (fake JWKS)", () => {
  test("valid Bearer token verifies; sub is returned", async () => {
    const { jwk, privateKey } = await newKey("k1");
    currentJwks = { keys: [jwk] };
    startJwks();
    const auth = new Auth(ISSUER_BASE, AUD);
    const payload = await auth.verify(await mint(privateKey, "k1", "user-1"));
    expect(payload.sub).toBe("user-1");
    stopJwks();
  });

  test("wrong audience is rejected", async () => {
    const { jwk, privateKey } = await newKey("k2");
    currentJwks = { keys: [jwk] };
    startJwks();
    const auth = new Auth(ISSUER_BASE, AUD);
    const t = await mint(privateKey, "k2", "user-2", { aud: "https://other.example" });
    await expect(auth.verify(t)).rejects.toThrow();
    stopJwks();
  });

  test("wrong issuer is rejected", async () => {
    const { jwk, privateKey } = await newKey("k3");
    currentJwks = { keys: [jwk] };
    startJwks();
    const auth = new Auth(ISSUER_BASE, AUD);
    const t = await mint(privateKey, "k3", "user-3", { iss: "https://someone-else/oidc" });
    await expect(auth.verify(t)).rejects.toThrow();
    stopJwks();
  });

  test("JWKS unreachable after first success: cached keys keep working; fresh Auth cannot boot (503 path)", async () => {
    const { jwk, privateKey } = await newKey("k4");
    currentJwks = { keys: [jwk] };
    startJwks();
    const auth = new Auth(ISSUER_BASE, AUD, 600000); // never refetch proactively
    await auth.verify(await mint(privateKey, "k4", "user-4")); // primes the cache

    stopJwks(); // JWKS now unreachable
    const payload = await auth.verify(await mint(privateKey, "k4", "user-5")); // from cache
    expect(payload.sub).toBe("user-5");

    const fresh = new Auth(ISSUER_BASE, AUD);
    await expect(fresh.verify(await mint(privateKey, "k4", "user-6"))).rejects.toBeInstanceOf(AuthUnavailableError);
  });

  test("key rotation: unknown kid triggers a refresh that picks up the new key", async () => {
    startJwks(); // server was stopped by the previous test
    const old = await newKey("k5-old");
    const fresh = await newKey("k5-new");
    currentJwks = { keys: [old.jwk] };
    const auth = new Auth(ISSUER_BASE, AUD, 600000);
    await auth.verify(await mint(old.privateKey, "k5-old", "user-7"));

    currentJwks = { keys: [fresh.jwk] }; // Logto rotated: new key published
    const payload = await auth.verify(await mint(fresh.privateKey, "k5-new", "user-8"));
    expect(payload.sub).toBe("user-8");
  });
});

// ---- C-04-21 (round 2, logto helper): keys survive an issuer outage; a cold pod is not ready; forced refreshes are rate-limited ----
describe("round 2: last good keys", () => {
  test("cold start while the issuer is down: not ready; after it returns: ready, no request ever waited on the issuer", async () => {
    const k = await newKey("c1");
    currentJwks = { keys: [k.jwk] };
    stopJwks(); // issuer down
    const a = new Auth(ISSUER_BASE, AUD);
    a.start();
    await new Promise((r) => setTimeout(r, 300));
    expect(a.ready).toBe(false);
    startJwks(); // issuer back (the retry loop picks it up within its backoff)
    for (let i = 0; i < 40 && !a.ready; i++) await new Promise((r) => setTimeout(r, 100));
    expect(a.ready).toBe(true);
    const tok = await mint(k.privateKey, "c1", "u1");
    stopJwks(); // issuer down again: verification must keep working from the cached keys, instantly
    const t0 = performance.now();
    const ok: string[] = [];
    for (let i = 0; i < 200; i++) ok.push(String((await a.verify(tok)).sub));
    expect(ok.every((s) => s === "u1")).toBe(true);
    expect(performance.now() - t0).toBeLessThan(500);
    a.stop();
    startJwks();
  });
  test("unknown key id: forced refresh at most once per 10 s", async () => {
    stopJwks();
    startJwks();
    const k = await newKey("c2");
    currentJwks = { keys: [k.jwk] };
    const a = new Auth(ISSUER_BASE, AUD);
    await a.refresh(true);
    let hits = 0;
    stopJwks();
    server = Bun.serve({ port: 46111, fetch(req) { if (new URL(req.url).pathname === "/oidc/jwks") { hits++; return Response.json(currentJwks); } return new Response("nf", { status: 404 }); } });
    const other = await newKey("zzz");
    const bad = await mint(other.privateKey, "zzz", "x");
    for (let i = 0; i < 20; i++) await a.verify(bad).catch(() => {});
    expect(hits).toBeLessThanOrEqual(1);
  });
});
