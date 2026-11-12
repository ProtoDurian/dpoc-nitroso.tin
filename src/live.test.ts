import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Z2Db } from "./lib/z2lib";
test("startup holds before any connection; stale HTTP doc cannot release; waiting write times out cleanly", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dpoc-z2-"));
  const doc = { gen: 7, hold: true, db: { host: "127.0.0.1", port: 1, user: "test", password: "test-only", database: "test", ssl: false } };
  writeFileSync(join(dir, "control.json"), JSON.stringify(doc));
  const db = new Z2Db({ id: "pod-test", control: join(dir, "control.json"), ctlPort: 46116, holdMaxMs: 80 });
  try {
    await db.start();
    expect(db.ackNow).toMatchObject({ id: "pod-test", gen: 7, hold: true, drained: true, inflight: 0 });
    const result = await (await fetch("http://127.0.0.1:46116/dbctl", { method: "POST", body: JSON.stringify({ ...doc, gen: 6, hold: false }) })).json();
    expect(result.gen).toBe(7); expect(result.hold).toBe(true);
    await expect(db.query("update acct set bal=bal+1")).rejects.toHaveProperty("code", "HOLD_TIMEOUT");
    expect(db.stats.inflight).toBe(0); expect(db.stats.holdTimeouts).toBe(1);
  } finally { await db.close(); rmSync(dir, { recursive: true }); }
});

