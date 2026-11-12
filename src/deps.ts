// Deps — all mounted dependency modules of tin, wired per PLAN §4/H2:
//   database main  -> AppDb  (lib/pgapp.ts, verbatim from spike m-pgmoves: write gate, fence hold, secret reload)
//   kv cache       -> KvApp  (lib/kvapp.ts)
//   store files    -> StoreApp (lib/storeapp.ts)
//   email mail     -> EmailApp (lib/emailapp.ts)
// Every module polls its secret file every 2 s and swaps its client on a generation
// change without dropping requests. A missing file at start keeps /healthz 200;
// API routes that need the module answer 503 "dependency <module> not ready".
import { AppDb } from "./lib/pgapp.ts";
import { KvApp } from "./lib/kvapp.ts";
import { StoreApp } from "./lib/storeapp.ts";
import { EmailApp } from "./lib/emailapp.ts";

export const DEPS_DIR = process.env.DPOC_DEPS_DIR ?? "/deps";
const POLL_MS = 2000;

export class Deps {
  readonly db: AppDb;
  readonly kv: KvApp;
  readonly store: StoreApp;
  readonly email: EmailApp;

  constructor(dir: string = DEPS_DIR) {
    this.db = new AppDb(`${dir}/database-main/secret.json`, { pollMs: POLL_MS, max: 10 });
    this.kv = new KvApp(`${dir}/kv-cache/secret.json`, POLL_MS);
    this.store = new StoreApp(`${dir}/store-files/secret.json`, POLL_MS);
    this.email = new EmailApp(`${dir}/email-mail/secret.json`, POLL_MS);
  }

  start() {
    this.db.start();
    this.kv.start();
    this.store.start();
    this.email.start();
  }
  async stop() {
    await this.db.stop();
    await this.kv.stop();
    this.store.stop();
    this.email.stop();
  }

  /** null when everything the notes API needs is ready; else the module that is missing. */
  missing(): string | null {
    if (!this.db.secret) return "main";
    if (!this.kv.ready) return "cache";
    if (!this.store.ready) return "files";
    if (!this.email.ready) return "mail";
    return null;
  }
}
