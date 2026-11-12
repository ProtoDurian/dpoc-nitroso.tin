// FileDep — one mounted dependency secret: /deps/<class>-<module>/secret.json (PLAN §4).
// Polled every pollMs; kubelet updates mounted Secrets in ~60 s and pods are NOT restarted on
// rotation, so the app swaps clients itself. A change in file content (usually a `generation`
// bump) swaps the client; a missing file (fresh landscape) or a mid-write/atomic-rename read
// keeps the previous state.
import { readFileSync } from "node:fs";

export type VersionedSecret = { generation: number };

export class FileDep<T extends VersionedSecret> {
  private raw = "";
  private cur: T | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;

  /** every accepted change, for logs/tests: {at, generation} */
  readonly changes: { at: number; generation: number }[] = [];

  constructor(
    readonly path: string,
    private readonly onSwap: ((prev: T | null, cur: T) => void) | null = null,
    private readonly pollMs = 2000,
  ) {}

  get current(): T | null {
    return this.cur;
  }
  get ready(): boolean {
    return this.cur !== null;
  }

  start() {
    this.poll();
    this.timer = setInterval(() => this.poll(), this.pollMs);
  }
  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private poll() {
    let raw: string;
    try {
      raw = readFileSync(this.path, "utf8");
    } catch {
      return; // not provisioned yet, or transient atomic-rename window -> keep current
    }
    if (raw === this.raw) return;
    let s: T;
    try {
      s = JSON.parse(raw);
    } catch {
      return; // torn write -> keep current, next tick retries
    }
    const prev = this.cur;
    this.raw = raw;
    this.cur = s;
    this.changes.push({ at: Date.now(), generation: s.generation });
    try {
      this.onSwap?.(prev, s);
    } catch (e) {
      console.error(JSON.stringify({ ts: new Date().toISOString(), evt: "dep-swap-error", path: this.path, err: String(e) }));
    }
  }
}
