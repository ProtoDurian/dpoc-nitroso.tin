// tests for the dependency loader (FileDep) — the mechanism under pgapp/kvapp/storeapp/emailapp.
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileDep } from "./lib/filedep.ts";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "dpoc-deps-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const write = (gen: number, extra: Record<string, unknown> = {}) =>
  writeFileSync(join(dir, "secret.json"), JSON.stringify({ generation: gen, ...extra }));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("FileDep", () => {
  test("missing file at start: not ready, no crash; appears later", async () => {
    const dep = new FileDep<{ generation: number; host: string }>(join(dir, "secret.json"), null, 20);
    dep.start();
    expect(dep.ready).toBe(false);
    expect(dep.current).toBeNull();
    write(1, { host: "a" });
    await sleep(80);
    expect(dep.ready).toBe(true);
    expect(dep.current!.host).toBe("a");
    dep.stop();
  });

  test("unchanged content does not swap; a generation change swaps", async () => {
    write(1, { host: "a" });
    const swaps: Array<{ prevHost: string | null; host: string; gen: number }> = [];
    const dep = new FileDep<{ generation: number; host: string }>(join(dir, "secret.json"), (prev, cur) => {
      swaps.push({ prevHost: prev?.host ?? null, host: cur.host, gen: cur.generation });
    }, 20);
    dep.start();
    await sleep(80);
    expect(swaps.length).toBe(1);
    expect(swaps[0]).toEqual({ prevHost: null, host: "a", gen: 1 });

    await sleep(100); // nothing changed
    expect(swaps.length).toBe(1);

    write(2, { host: "b" });
    await sleep(80);
    expect(swaps.length).toBe(2);
    expect(swaps[1]).toEqual({ prevHost: "a", host: "b", gen: 2 });
    expect(dep.current!.generation).toBe(2);
    dep.stop();
  });

  test("corrupt JSON (torn write) keeps the previous secret", async () => {
    write(3, { host: "a" });
    const dep = new FileDep<{ generation: number; host: string }>(join(dir, "secret.json"), null, 20);
    dep.start();
    await sleep(80);
    writeFileSync(join(dir, "secret.json"), '{"generation": 4, "host":'); // torn
    await sleep(80);
    expect(dep.current!.generation).toBe(3);
    expect(dep.current!.host).toBe("a");
    dep.stop();
  });

  test("file disappearing keeps the last known secret", async () => {
    write(5, { host: "a" });
    const dep = new FileDep<{ generation: number; host: string }>(join(dir, "secret.json"), null, 20);
    dep.start();
    await sleep(80);
    rmSync(join(dir, "secret.json"));
    await sleep(80);
    expect(dep.ready).toBe(true);
    expect(dep.current!.generation).toBe(5);
    dep.stop();
  });

  test("every accepted change is recorded in .changes", async () => {
    write(1, { host: "a" });
    const dep = new FileDep<{ generation: number }>(join(dir, "secret.json"), null, 20);
    dep.start();
    await sleep(60);
    write(2, {});
    await sleep(80);
    expect(dep.changes.map((c) => c.generation)).toEqual([1, 2]);
    dep.stop();
  });
});
