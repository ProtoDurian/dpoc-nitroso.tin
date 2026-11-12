// StoreApp — S3-compatible object store (Tigris) client for one mounted store secret
// (PLAN §4 shape: {endpoint, region, bucket, accessKeyId, secretAccessKey, generation}).
// aws4fetch signs each request (SigV4); a generation change just rebuilds the signer.
// PUTs are idempotent, so a network/5xx failure is retried once safely.
import { AwsClient } from "aws4fetch";
import { FileDep } from "./filedep.ts";

export type StoreSecret = { endpoint: string; region: string; bucket: string; accessKeyId: string; secretAccessKey: string; generation: number };

export class StoreApp {
  private dep: FileDep<StoreSecret>;
  private client: AwsClient | null = null;

  constructor(secretPath: string, pollMs = 2000) {
    this.dep = new FileDep<StoreSecret>(secretPath, (_prev, cur) => this.swap(cur), pollMs);
  }

  start() {
    this.dep.start();
  }
  stop() {
    this.dep.stop();
  }

  get ready(): boolean {
    return this.dep.ready;
  }
  get generation(): number | undefined {
    return this.dep.current?.generation;
  }

  private swap(cur: StoreSecret) {
    this.client = new AwsClient({
      accessKeyId: cur.accessKeyId,
      secretAccessKey: cur.secretAccessKey,
      service: "s3",
      region: cur.region || "auto",
      retries: 1,
    });
  }

  private url(key: string): string {
    const s = this.dep.current!;
    const k = key.split("/").map(encodeURIComponent).join("/");
    return `${s.endpoint.replace(/\/+$/, "")}/${s.bucket}/${k}`;
  }

  async putObject(key: string, body: string, contentType = "application/json"): Promise<void> {
    const c = this.client;
    if (!c) throw new Error("store not ready");
    let lastErr: unknown = new Error(`store put ${key}: no attempts`);
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const r = await c.fetch(this.url(key), { method: "PUT", headers: { "content-type": contentType }, body });
        if (r.ok) return;
        lastErr = new Error(`store put ${key}: ${r.status}`);
        if (r.status !== 404 && r.status < 500 && r.status !== 429) throw lastErr; // real 4xx: retrying cannot help
      } catch (e) {
        lastErr = e;
      }
    }
    throw lastErr;
  }

  async getObject(key: string): Promise<string | null> {
    const c = this.client;
    if (!c) throw new Error("store not ready");
    const r = await c.fetch(this.url(key), { method: "GET" });
    if (r.status === 404) return null;
    if (!r.ok) throw new Error(`store get ${key}: ${r.status}`);
    return r.text();
  }
}
