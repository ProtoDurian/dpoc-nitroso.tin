// Compatibility adapter: existing tin writes use Z2's transaction gate; no write is retried.
import { Z2Db } from "./z2lib";
import { hostname } from "node:os";
export class LiveAppDb {
  readonly plain: Z2Db;
  constructor(path: string) {
    this.plain = new Z2Db({ id: process.env.POD_UID ?? hostname(), lang: "bun", mode: "live",
      control: path.replace(/secret.json$/, "control.json"), legacySecret: path, ctlPort: Number(process.env.DB_CTL_PORT ?? 8081),
      writePool: 8, readPool: 4, holdMaxMs: 60000, connectTimeoutMs: 15000 });
  }
  start() { void this.plain.start().catch(e => { console.error(JSON.stringify({ evt: "db-start-failed", code: e.code ?? "unknown" })); process.exitCode = 1; }); }
  async stop() { await this.plain.close(); }
  get secret() { return this.plain.address; }
  async write<T>(fn: (c: any) => Promise<T>, _opts?: any) { return { v: await this.plain.begin(fn), retries: 0, heldMs: 0, kinds: [] }; }
  async read<T>(fn: (c: any) => Promise<T>) {
    return { v: await fn({ query: (q: any, p?: any[]) => this.plain.read(q, p) }), retries: 0, heldMs: 0, kinds: [] };
  }
}

