# Hosted deployment (decided 2026-08-04, merged to one origin 2026-08-10)

## The same mock, two roles (P2-DEVSTART, 2026-08-06)
The FastAPI mock in `mock/` is used in two different ways — keep them apart
when reading this document:
- **On your machine**: the bundled DEMO BACKEND for local development. Boot it
  with the UI in one command — `npm start` — which reads `localMock
  {enabled, port, dbPath}` from `agentic.config.ts` (the one config artifact),
  passes `dbPath` as `CUPEL_MOCK_DB`, and prints the backend and its storage
  location at startup. Storage is a plain SQLite file on your filesystem
  (`mock/cupel-mock.sqlite`, git-ignored). See README.md.
- **Deployed (this document)**: the mock IS the whole backend of the hosted
  demo. It runs on a free tier with no persistent disk, so its SQLite file is
  replicated to object storage instead (see **Storage modes**).

Adopters connecting Cupel to their own backend set `localMock.enabled: false`
and point `defaultTarget.dev` at their target; `npm start` then runs the UI
only and their backend holds all persistence. `npm run dev` / `npm run mock`
still exist for anyone who prefers two terminals.

## One origin: the landing page AND the demo (mock/root.py)
Everything public — the persona landing page and the running demo — is ONE
Render service, ONE Docker container, ONE origin:

- `GET /` serves `docs/index.html`, the landing page.
- `/cupel-demo/*` is the whole demo (API + built Vite bundle), mounted there
  by `mock/root.py` via Starlette's `Mount`. Mounting strips the
  `/cupel-demo` prefix before routing into `mock/main.py`'s app, so every
  route it declares (`/healthz`, `/me`, `/openapi.json`, the SPA catch-all,
  ...) is written exactly as it always was and simply becomes reachable one
  level down — no prefix threaded through the route table, the permission
  gate's path-template regexes, or the SPA static serving. FastAPI's own
  `root_path` handling does the rest: the demo's contract is served at
  **`/cupel-demo/openapi.json`** for free (docs/readiness.md).
- The SPA side carries the mirror-image change: `vite.config.ts` builds with
  `base: "/cupel-demo/"` (build-only — the dev server stays at `/`), and
  `src/main.tsx` mounts the router with `basename="/cupel-demo"` in
  production only (`import.meta.env.PROD`), so the built bundle's own
  asset/route URLs already carry the prefix the browser will request.
- The demo's own sidebar carries a plain `<a href="/">Landing / FAQ</a>` back
  to the landing page (not a router link — the landing page is a sibling
  route on the same origin, not part of the SPA).

**No access gate.** Phase-1 demo data is not sensitive (deterministic seed,
reset on every restart under `CUPEL_STORAGE=local`), so there is no shared
token to distribute — share `https://cupel-site.onrender.com/cupel-demo/`
directly. (An earlier version of this deployment gated the whole origin
behind a `DEMO_TOKEN` shared-token middleware; that gate, its cookie, and the
`?token=` URL form are gone — removed 2026-08-10 along with the merge into one
service.)

## Host: Render free tier
- One Docker container: FastAPI serves the landing page, the API, AND the
  built Vite bundle.
- Free tier constraints, accepted:
  - Spins down after 15 min idle, ~1 min cold start → warm the URL before
    sharing it with the client.
  - No persistent disk → the container's filesystem is ephemeral. See
    **Storage modes** below: `CUPEL_STORAGE=local` accepts that (every restart
    starts from the seed), `CUPEL_STORAGE=s3` replicates the SQLite file to a
    bucket so the demo's data survives.
- Upgrade path: Fly.io ~$2/mo machine + volume when always-on is wanted.
  AWS only if the client's org requires it, or for the Phase-3 Helm/k8s story.

## Storage modes (P2-PERSIST, 2026-08-06; live on the demo 2026-08-11)
**SQLite is the database in both roles. Only the DURABILITY of the file
changes**, and it is selected by one environment variable:

| `CUPEL_STORAGE` | What it is | Who runs it |
| --- | --- | --- |
| `local` (default) | A plain SQLite file at `CUPEL_MOCK_DB`. No S3 code path, no extra env, no extra process. | Every developer checkout. |
| `s3` | The same SQLite file, continuously replicated to an S3-compatible bucket by [Litestream](https://litestream.io) and restored from it on boot. | The hosted demo, where the mock IS the whole backend and the disk is ephemeral. This is what `cupel-site` runs (`render.yaml`). |

Nothing about the app changes between the two: the same FastAPI process, the
same schema, the same endpoints. `local` is exactly the behaviour that shipped
before this task.

`CUPEL_STORAGE` lives in `render.yaml`, not only in the Render dashboard,
because a blueprint apply rewrites the service's environment from that file —
pinning `local` there would silently revert a dashboard flip and put the demo
back to wiping itself, with nothing raised, since degradation is deliberate
(`mock/boot.py:24-29`). The four credentials stay dashboard-only; a per-key
`PUT /v1/services/{id}/env-vars/{key}` was observed to leave the service's
other variables untouched.

### How s3 mode boots
`mock/boot.py` is the container's `CMD`. In `local` mode it simply execs
`python -m mock.entrypoint`. In `s3` mode it:
1. renders `/etc/litestream.yml` from the `CUPEL_S3_*` env
   (`mock/storage.py:litestream_yml`) — **credentials are not written into the
   file**; Litestream reads `LITESTREAM_ACCESS_KEY_ID` /
   `LITESTREAM_SECRET_ACCESS_KEY` from the environment;
2. runs `litestream restore -if-db-not-exists -if-replica-exists`, so an
   existing database is never clobbered and an empty bucket (first ever boot)
   is a success, not an error;
3. execs `litestream replicate -exec "python -m mock.entrypoint"` — the app
   runs as Litestream's child, and every committed WAL frame is shipped to the
   bucket within seconds.

`mock/db.py` sets `journal_mode=WAL` (plus `synchronous=NORMAL`,
`busy_timeout=5000`) unconditionally, in both modes: Litestream replicates WAL
frames and refuses a rollback-journal database, and running one engine
configuration everywhere keeps the hosted path from being a special case.

### ⚠️ SINGLE WRITER — NEVER SCALE THIS SERVICE
SQLite + Litestream replicates **exactly one writing process**. Two instances
writing to the same bucket **corrupt the replica** — this is not graceful
degradation, it is data loss, and it is silent until a restore comes back
broken. Therefore:
- keep the service at **one instance** (`render.yaml` has no `numInstances`;
  do not add one, and do not enable autoscaling);
- never point a second service, a second environment, or a local `npm start`
  at the same `CUPEL_S3_BUCKET` + `CUPEL_S3_PATH`. Use a different prefix for
  anything else;
- a blue/green or zero-downtime deploy that briefly runs two containers is
  also two writers. Render free-tier deploys stop the old container first, so
  this is safe today — re-check it before changing plan.
If you need more than one writer, you need a different database, not a
different replication setting (see review bucket D, `docs/review-2026-08-05.md`).

### Setting the demo up on Cloudflare R2 (or AWS S3)
R2 is the cheap default: no egress fees, S3-compatible, free tier covers a
demo database comfortably.
1. Cloudflare dashboard → **R2** → *Create bucket* → name it `cupel-demo`,
   location automatic. Leave public access **off** — Litestream uses the S3 API
   with credentials, not public URLs.
2. R2 → **Manage API tokens** → *Create API token* → permission **Object Read
   & Write**, scoped to that one bucket. Copy the **Access Key ID** and
   **Secret Access Key** (shown once).
3. Note the S3 endpoint from the bucket's settings:
   `https://<account-id>.r2.cloudflarestorage.com`.
4. Render dashboard → the `cupel-site` service → **Environment** → add:

   | Variable | Value | Required |
   | --- | --- | --- |
   | `CUPEL_S3_BUCKET` | `cupel-demo` | yes |
   | `CUPEL_S3_ENDPOINT` | `https://<account-id>.r2.cloudflarestorage.com` | yes |
   | `CUPEL_S3_ACCESS_KEY_ID` | R2 token access key id | yes |
   | `CUPEL_S3_SECRET_ACCESS_KEY` | R2 token secret | yes |
   | `CUPEL_S3_PATH` | key prefix inside the bucket — the demo uses `sample-cupel-data` | in practice |
   | `CUPEL_S3_REGION` | `auto` for R2; the real region for AWS | no |

   `CUPEL_STORAGE=s3` is NOT set here — it comes from `render.yaml` (above).
   The four credentials are secrets and belong in the dashboard only.

   `CUPEL_S3_PATH` is marked optional by the code (`mock/storage.py:41` defaults
   it to `cupel-mock`) but is effectively required by any deployment that has
   already chosen a prefix: omit it and the demo silently starts a SECOND,
   empty replica alongside the real one rather than failing.

   Keep `CUPEL_SEED_ON_BOOT=1` and `CUPEL_SEED=42` — they now mean *seed if
   empty* (below), so they are safe to leave on with a durable database.
5. **Deploy explicitly. Setting environment variables does not restart the
   service.** Until you do, the old container keeps serving and keeps
   reporting `mode:"local"` — indistinguishable from a degraded boot unless
   you compare the running deploy's creation time against when you set the
   variables. Trigger one (`POST /v1/services/{id}/deploys`, or *Manual
   Deploy* in the dashboard) and wait for `live`.
6. Check `GET /cupel-demo/healthz`:
   `{"status":"ok", ..., "storage":{"mode":"s3","restored":true}}`.
   `restored:false` on the very first boot is correct (the bucket was empty);
   `"mode":"local"` when you asked for `s3` means the boot degraded — read the
   logs, `mock/boot.py` names the missing variable.
7. Confirm the bucket is actually receiving writes before trusting any of it:
   `aws s3 ls s3://cupel-demo/ --recursive --endpoint-url <endpoint> --region auto`
   should show `<prefix>/0000/*.ltx` objects with timestamps from this boot.

For **AWS S3** instead: same variables, `CUPEL_S3_ENDPOINT` =
`https://s3.<region>.amazonaws.com`, `CUPEL_S3_REGION` = the real region, and
an IAM user with `s3:GetObject/PutObject/DeleteObject/ListBucket` on that
bucket only.

### Seed on boot = seed **if empty**
`CUPEL_SEED_ON_BOOT=1` used to re-seed on *every* boot — the mitigation for a
disk that lost everything anyway. It now means "make sure this backend has
data": `mock/entrypoint.py:should_seed` skips seeding whenever the database
already holds conversations. Without that rule, every restart of an s3-backed
demo would layer a fresh generator seed on top of real data — the generator
dedupes chats (deterministic `client_message_id`) and skips forks/replays/
judgments by check-before-create, but runs and judgments can still accrete,
which was only ever tolerable because the disk was ephemeral. The empty case
is unchanged: the same deterministic `--seed 42` dataset as before.

### What happens when things go wrong
Nothing here is fatal — the demo keeps serving, because a crash loop would
take it down to protect data that by definition was not there:

| Failure | Behaviour |
| --- | --- |
| Restore fails (bad credentials, unreachable endpoint, corrupt replica) | Logged as `WARNING: litestream restore failed`; the app starts on a **fresh empty database**, which the boot seed then fills. No crash loop. |
| Bucket is empty (first boot) | Not an error — `-if-replica-exists`. Fresh database, seeded, and replication starts from there. |
| A `CUPEL_S3_*` variable is missing | Logged with the exact variable names, and the container runs **local and unreplicated**. `/cupel-demo/healthz` reports `mode:"local"`, so it never claims durability it does not have. |
| `litestream` binary missing | Same degradation, logged. (The image always ships it; this only bites a hand-rolled runtime.) |
| Replication falls behind / errors mid-run | Litestream logs and retries; the app is unaffected. |

`/cupel-demo/healthz` is the fastest check — it reports the **effective**
mode, not the requested one. `npm start` prints the same thing in its banner.

### `restored:true` is necessary, not sufficient
It answers "did a file come back from the replica?" — not "was that file
current?". And because seeding is now seed-**if-empty**, a restore that fails
outright leaves an empty database that the boot seed refills with the same
deterministic `--seed 42` dataset, so a *broken* demo and a *working* one look
alike from the outside: same rubrics, same conversations, same counts.

To distinguish them, compare a value the generator cannot reproduce — a row's
creation timestamp — across the restart:

```
GET /cupel-demo/eval/rubrics?page_size=100     # before, note created
<restart>
GET /cupel-demo/eval/rubrics?page_size=100     # after, must be IDENTICAL
```
Unchanged timestamps mean the database was restored. Changed ones mean it was
re-seeded, whatever `restored` says.

Check a new bucket's credentials independently before trusting a deploy to
exercise them: an `aws s3` put/get/delete round trip covers the three
operations Litestream needs.

### Running s3 mode on your machine (verification, not routine use)
`CUPEL_STORAGE=s3` plus the `CUPEL_S3_*` variables makes `npm start` boot
`python -m mock.boot` instead of uvicorn directly, and the banner names the
replica. You need the `litestream` binary on `PATH` — it ships a Windows build
too, so this needs no container. **Use a different `CUPEL_S3_PATH` than the
deployed demo** — see the single-writer rule.

On Windows, Litestream logs one `sync error … Access is denied` against the
local sidecar directory and recovers a second later. That is a directory-fsync
difference, not a replication failure, and it does not occur on the Linux image.

## How to deploy (P1-TDEPLOY)
Everything ships in-repo: `Dockerfile` (stage 1 builds the Vite bundle with
`base: "/cupel-demo/"`, stage 2 supplies the pinned litestream binary, stage 3
runs `mock/root.py`'s merged app), `render.yaml` (blueprint), `mock/boot.py`
(picks the storage mode), `mock/entrypoint.py` (boot: serve → wait
`/cupel-demo/healthz` → seed if empty).

1. Push the repo to GitHub, then either:
   - **Blueprint**: Render dashboard → New → Blueprint → pick the repo;
     `render.yaml` creates one free Docker web service named `cupel-site`
     with health check `/cupel-demo/healthz`, `CUPEL_SEED_ON_BOOT=1`,
     `CUPEL_SEED=42`; or
   - **Manual**: New → Web Service → Docker runtime → free plan, health check
     path `/cupel-demo/healthz`, and set those two env vars yourself.
2. On boot the container serves immediately and, **if the database comes up
   empty**, seeds itself deterministically through the public API (generator
   seed mode). A database restored from an s3 replica is left alone — see
   "Seed on boot = seed if empty".
3. Share the URL as-is — no token, no query param:
   `https://cupel-site.onrender.com/cupel-demo/`. Machine callers hit
   `https://cupel-site.onrender.com/cupel-demo/openapi.json` etc. directly
   (e.g. `python -m mock.generator drip --base
   https://cupel-site.onrender.com/cupel-demo`).
4. Local smoke without Docker: `npm run build`, then
   `CUPEL_SEED_ON_BOOT=1 python -m mock.entrypoint` and open
   `http://localhost:4010/` (landing page) or
   `http://localhost:4010/cupel-demo/` (the demo).

### Consolidating the two existing Render services into this one (done 2026-08-10)
Before 2026-08-10 this was TWO separate Render services: a Docker service
(`cupel-demo` in `render.yaml`, but Render minted the hostname
`skein.onrender.com` at creation and never changed it) running the demo alone,
and a standalone Static Site (`cupel-site`, dashboard-configured, not in this
repo) serving only `docs/index.html`. This document and `render.yaml` describe
the END STATE this repo now runs — one Docker service, named `cupel-site`,
serving both. Kept here as a record of what it took, and as the playbook if
this ever needs redoing (e.g. a future rename):
1. **Delete** both old services — `srv-...` the Docker one (`skein.onrender.com`)
   and the standalone Static Site. **Suspending is not enough**: a suspended
   service still reserves its name, so creating a new service under the same
   name 400s with `name: (cupel-site) already in use` until it is actually
   gone. Both die instantly with no redirect; safe here because
   `CUPEL_STORAGE=local` means the demo dataset was already just the
   deterministic seed, regenerated on first boot — nothing to carry over.
2. Create a fresh Docker service named `cupel-site` from `render.yaml`'s
   config (Render dashboard → New → Blueprint, or the Render API directly).
   Render hostnames are minted from the service name at creation and are
   available once nothing else holds that exact name — this reclaimed
   `cupel-site.onrender.com`.
3. One deploy failure surfaced doing this live: the Dockerfile's
   `COPY docs/index.html` / `COPY docs/assets` (needed so `mock/root.py` has a
   landing page and its logo photo to serve) had nothing to read, because
   `.dockerignore` blanket-excluded `docs/` from the build CONTEXT. Fixed by
   narrowing `.dockerignore`, not the Dockerfile — `.dockerignore` only gates
   what reaches the build, never what a `COPY` puts in the final image.

## Live-LLM BYOK mode (P1-T18c)
Mock stays the backend of record (conversations, tasks, runs, SQLite, SSE);
only the generation call inside chat/replay/judge goes to a real provider
when a key is present.
- Provider: OpenRouter (OpenAI-compatible, one key → many cheap models:
  DeepSeek, Gemini Flash tier, Claude Haiku tier, ...). /models is populated
  from a curated cheap-model list in live mode.
- Key handling (hard rules):
  - Client pastes key in UI → browser localStorage only.
  - Sent per request: X-LLM-Key + X-LLM-Model headers.
  - Server uses it in-memory for that request; NEVER persisted, NEVER logged.
  - No /settings endpoint involved (deferred to Phase 2 — no build-ahead).
- Cost control: server-side max_tokens cap + a sliding-window rate limit per
  key hash, so drip/replay can't burn the client's credit.
- Over the limit → **429 `rate_limited` with `Retry-After`**, answered at the
  door before a conversation, turn or task is created. It used to answer 200
  with canned content and note `rate_limited` on the llm span, which meant a
  BYOK caller was handed mock text under their own key with no signal. Only a
  request carrying X-LLM-Key is limited — canned generation costs nothing.
  Replay/judge CHILDREN are the deliberate exception: they run long after
  their 202, so there is no request left to fail and they keep the canned
  fallback plus the span note.
- No key present → canned mock responses as before (default).
