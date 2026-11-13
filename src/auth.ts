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
  private timer: ReturnType<typeof setTimeout> | null = null;
  private lastForced = 0;

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

  /** C-04-21: true once a key set was loaded. healthz is 503 before that, so a pod that starts while Logto is restarting takes no traffic it cannot verify. */
  get ready(): boolean {
    return this.keys !== null;
  }

  start() {
    // retry with backoff (1,2,4,8,15 s) until the FIRST key set is loaded, then every 10 min; a request never waits on the issuer once keys exist
    const first = async (delay = 1000): Promise<void> => {
      await this.refresh(true).catch(() => {});
      if (!this.keys) this.timer = setTimeout(() => void first(Math.min(delay * 2, 15000)), delay);
    };
    void first();
    setInterval(() => this.refresh().catch(() => {}), 600000);
  }
  stop() {
    if (this.timer) clearTimeout(this.timer);
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
        // rotation: forced pickup of new keys, at most once per 10 s (a random kid must not turn every request into an issuer call); old set kept on failure
        if (Date.now() - this.lastForced > 10000) {
          this.lastForced = Date.now();
          await this.refresh(true);
        }
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
