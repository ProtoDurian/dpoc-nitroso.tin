// One local run of the server against a fake secret dir with NO database (H2 proof):
//   /healthz  -> 200 with x-dpoc-cluster
//   /api/info -> 200 {cluster, landscape, version}
//   /api/notes (GET and POST) -> 503 {"error":"dependency main not ready"}
//   SIGTERM   -> /healthz 503 (draining), still serves /api/info, exits ~10 s later
// Run: bun dev/run-nodb.ts
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PORT = 43111;
const base = `http://127.0.0.1:${PORT}`;

const depsDir = mkdtempSync(join(tmpdir(), "dpoc-fake-deps-"));
// fresh landscape: only the email secret exists; database/kv/store are missing
mkdirSync(join(depsDir, "email-mail"), { recursive: true });
writeFileSync(join(depsDir, "email-mail/secret.json"), JSON.stringify({ type: "log", from: "noreply@pichu.dpoc.specpenguin.dev", generation: 1 }));

const proc = Bun.spawn(["bun", "src/index.ts"], {
  cwd: import.meta.dir + "/..",
  env: {
    ...process.env,
    PORT: String(PORT),
    DPOC_DEPS_DIR: depsDir,
    DPOC_CLUSTER: "pichu-opal",
    DPOC_LANDSCAPE: "pichu",
    DPOC_ISSUER: "http://127.0.0.1:9/oidc", // nothing listens there on purpose
  },
  stdout: "pipe",
  stderr: "pipe",
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const logLines: string[] = [];
const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader();
(async () => {
  const dec = new TextDecoder();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    logLines.push(...dec.decode(value).split("\n").filter(Boolean));
  }
})();

let failures = 0;
const check = (name: string, ok: boolean, detail: string) => {
  console.log(`${ok ? "PASS" : "FAIL"} ${name} — ${detail}`);
  if (!ok) failures++;
};

try {
  await sleep(1500); // let it listen

  const hz = await fetch(`${base}/healthz`);
  check("healthz 503 before schema is ready", hz.status === 503, `status=${hz.status} cluster=${hz.headers.get("x-dpoc-cluster")}`);

  const info = await fetch(`${base}/api/info`);
  const infoBody = await info.json();
  check(
    "api/info 200 no auth",
    info.status === 200 && infoBody.cluster === "pichu-opal" && infoBody.landscape === "pichu",
    JSON.stringify(infoBody),
  );

  const post = await fetch(`${base}/api/notes`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "hi" }) });
  const postBody = await post.json();
  check("api/notes POST 503 dependency main not ready", post.status === 503 && postBody.error === "dependency main not ready", JSON.stringify(postBody));

  const get = await fetch(`${base}/api/notes`, { headers: { authorization: "Bearer x" } });
  check("api/notes GET 503 dependency main not ready", get.status === 503, `status=${get.status}`);
  const getOne = await fetch(`${base}/api/notes/xyz`, { headers: { authorization: "Bearer x" } });
  check("api/notes/:id GET 503 dependency main not ready", getOne.status === 503, `status=${getOne.status}`);

  const cors = await fetch(`${base}/api/info`, { headers: { origin: "https://web.nitroso.pichu.c.dpoc.specpenguin.dev" } });
  check(
    "CORS reflects dpoc origin",
    cors.headers.get("access-control-allow-origin") === "https://web.nitroso.pichu.c.dpoc.specpenguin.dev",
    `acao=${cors.headers.get("access-control-allow-origin")}`,
  );
  const noCors = await fetch(`${base}/api/info`, { headers: { origin: "https://evil.example" } });
  check("CORS ignores foreign origin", noCors.headers.get("access-control-allow-origin") === null, `acao=${noCors.headers.get("access-control-allow-origin")}`);

  proc.kill("SIGTERM");
  await sleep(1000);
  const hz2 = await fetch(`${base}/healthz`).catch(() => null);
  check("after SIGTERM: healthz 503 while draining", hz2 !== null && hz2.status === 503, hz2 ? `status=${hz2.status}` : "connection closed already");
  const info2 = await fetch(`${base}/api/info`).catch(() => null);
  check("after SIGTERM: still serving other routes 10 s", info2 !== null && info2.status === 200, info2 ? `status=${info2.status}` : "connection closed already");

  const t0 = Date.now();
  const code = await proc.exited;
  const waited = Date.now() - t0;
  check("exits ~10 s after SIGTERM with code 0", code === 0 && waited > 7000 && waited < 15000, `code=${code} ${waited}ms after signal`);
} finally {
  try { proc.kill(9); } catch {}
  rmSync(depsDir, { recursive: true, force: true });
}
console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
console.log("server log tail:", logLines.slice(-6));
process.exit(failures === 0 ? 0 : 1);
