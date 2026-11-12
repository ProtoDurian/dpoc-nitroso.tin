// KvApp — Upstash Redis client for one mounted kv secret (PLAN §4 shape:
// {url, host, port, password, tls, generation}). Same lifecycle rules as lib/pgapp.ts:
// poll the file, build a NEW client when the content (generation) changes, keep the old
// client alive for a grace period so in-flight requests never see a dropped connection.
import Redis from "ioredis";
import { FileDep } from "./filedep.ts";

export type KvSecret = { url: string; host: string; port: number; password: string; tls: boolean; generation: number };

const RETIRE_MS = 10000;

export class KvApp {
  private dep: FileDep<KvSecret>;
  private client: Redis | null = null;
  private old: Redis[] = [];

  constructor(secretPath: string, pollMs = 2000) {
    this.dep = new FileDep<KvSecret>(secretPath, (_prev, cur) => this.swap(cur), pollMs);
  }

  start() {
    this.dep.start();
  }
  async stop() {
    this.dep.stop();
    const all = [this.client, ...this.old].filter((c): c is Redis => !!c);
    await Promise.allSettled(all.map((c) => c.quit().catch(() => c.disconnect())));
  }

  get ready(): boolean {
    return this.dep.ready;
  }
  get generation(): number | undefined {
    return this.dep.current?.generation;
  }

  private swap(cur: KvSecret) {
    const prev = this.client;
    this.client = new Redis(cur.url, {
      lazyConnect: false,
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false,
      connectTimeout: 3000,
      retryStrategy: (times: number) => Math.min(times * 250, 2000),
    });
    this.client.on("error", () => {}); // surfaced per-request; never crash the pod
    if (prev) {
      this.old.push(prev);
      setTimeout(() => {
        prev.quit().catch(() => prev.disconnect());
        this.old = this.old.filter((c) => c !== prev);
      }, RETIRE_MS);
    }
  }

  async incr(key: string): Promise<number> {
    const c = this.client;
    if (!c) throw new Error("kv not ready");
    return c.incr(key);
  }
}
