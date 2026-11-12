// Auth — Bearer JWT verification against the landscape Logto issuer (env DPOC_ISSUER,
// e.g. https://lithium.aldehyde.pichu.c.dpoc.specpenguin.dev/oidc). JWKS is fetched from
// <issuer>/jwks, cached in memory and KEPT on fetch failure (a Logto blip must not log
// users out). A refresh is retried on an unknown key id (rotation) and every 10 min.
import { createLocalJWKSet, jwtVerify } from "jose";

type KeyStore = ReturnType<typeof createLocalJWKSet>;

export class AuthUnavailableError extends Error {}

export class Auth {
  private keys: KeyStore | null = null;
  private lastOk = 0;
  private inflight: Promise<void> | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    readonly issuer: string,
    readonly audience: string,
    private readonly minRefetchMs = 300000,
  ) {
    if (!issuer) throw new Error("DPOC_ISSUER env is required");
  }

  get jwksUrl(): string {
    return this.issuer.replace(/\/+$/, "") + "/jwks";
  }

  start() {
    this.refresh().catch(() => {});
    this.timer = setInterval(() => this.refresh().catch(() => {}), 600000); // 10 min best-effort
  }
  stop() {
    if (this.timer) clearInterval(this.timer);
  }

  /** returns the payload ({sub, ...}) or throws. AuthUnavailableError -> 503, anything else -> 401. */
  async verify(token: string): Promise<{ sub: string; [k: string]: unknown }> {
    let store = this.keys;
    if (!store) {
      await this.refresh();
      store = this.keys;
      if (!store) throw new AuthUnavailableError("jwks unavailable");
    }
    try {
      return await this.check(token, store);
    } catch (e: any) {
      const code = String(e?.code ?? "");
      const msg = String(e?.message ?? "");
      if (code === "ERR_JWKS_NO_MATCHING_KEY" || /no matching key|unable to find/i.test(msg)) {
        await this.refresh(true); // rotation: forced pickup of new keys; keep old set on failure
        if (this.keys) return this.check(token, this.keys);
      }
      throw e;
    }
  }

  private async check(token: string, store: KeyStore) {
    const { payload } = await jwtVerify(token, store, { issuer: this.issuer, audience: this.audience });
    return payload as { sub: string; [k: string]: unknown };
  }

  /** best-effort fetch; on failure the previous key set stays live. force skips the freshness guard. */
  refresh(force = false): Promise<void> {
    if (this.inflight) return this.inflight;
    if (!force && this.keys && Date.now() - this.lastOk < this.minRefetchMs) return Promise.resolve();
    this.inflight = (async () => {
      try {
        const r = await fetch(this.jwksUrl, { signal: AbortSignal.timeout(5000) });
        if (r.ok) {
          const jwks = await r.json();
          const next = createLocalJWKSet(jwks);
          this.keys = next; // swap only after a successful parse
          this.lastOk = Date.now();
        }
      } catch {
        // network/HTTP failure: keep the cached keys
      } finally {
        this.inflight = null;
      }
    })();
    return this.inflight;
  }
}
