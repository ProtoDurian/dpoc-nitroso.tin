# dpoc-nitroso.tin

The nitroso platform's notes API (bun). Public host `tin.nitroso.<landscape>.<root>`
(e.g. `tin.nitroso.pichu.c.dpoc.specpenguin.dev`).

- `GET /healthz` 200 · `GET /api/info` `{cluster, landscape, version}` (no auth)
- `GET /api/whoami` → `{sub, cluster}` — Bearer JWT, issuer `DPOC_ISSUER`
  (`https://lithium.aldehyde.<l>.<root>/oidc`), audience `https://tin.nitroso.dpoc`,
  JWKS cached in memory and kept on fetch failure.
- `POST /api/notes {text}` → `{id, cluster}` — Bearer; `Idempotency-Key` header is the row id
  (writes Postgres row + Redis INCR + store object `notes/<id>`; pg is the record of truth,
  kv/store failures are logged and flagged in `x-dpoc-writes`).
- `GET /api/notes/:id` → the note.
- Every response carries `x-dpoc-cluster`. SIGTERM → readiness 503, serve 10 s, exit.

Dependencies (PLAN §4) come only from `/deps/<class>-<module>/secret.json`, polled every 2 s;
a `generation` change swaps the client without dropping requests (`src/lib/`). A missing
file keeps `/healthz` 200 and the routes that need it answer
`503 {"error":"dependency <module> not ready"}`. The database volume is NOT optional in the
chart (G3: the pod waits for T3's Secret); db schema init retries with backoff.

`src/lib/pgapp.ts` is copied verbatim from spike m-pgmoves (fence hold, retry rules, B1–B7).

CORS: responses reflect an `Origin` whose host ends in `.dpoc.specpenguin.dev` so the web
frontend (different hostname, same landscape+root) can call the API.

## Layout
- `src/` app · `dev/run-nodb.ts` local no-DB smoke · tests in `src/*.test.ts` (`bun test`)
- `infra/app` chart `dpoc-nitroso-tin` (Deployment/Service/Ingress) · `infra/app/landscapes/<l>.yaml`
- `infra/primordial` chart `dpoc-nitroso-tin-primordial` (Database/KeyValue/Store/Email + LogtoApp)

## Release
Push a tag `vX.Y.Z` (GitHub secret `DPOC_REG_PASSWORD` must exist). The workflow pushes, in
order: image `reg.dpoc.specpenguin.dev/dpoc-nitroso-tin:X.Y.Z`, then the primordial chart,
then the app chart (LAST — same-version freight completes only then). Same commands work
locally with `VER=X.Y.Z` and a docker/helm login.
