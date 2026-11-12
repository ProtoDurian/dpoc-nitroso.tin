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
