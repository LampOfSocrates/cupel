# Phase-1 demo deployment (decided 2026-08-04)

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
  demo — it also serves the built bundle from the same origin. Everything
  below is about that role. It runs on a free tier with no persistent disk,
  so its SQLite file is replicated to object storage instead (see
  **Storage modes**).

Adopters connecting Cupel to their own backend set `localMock.enabled: false`
and point `defaultTarget.dev` at their target; `npm start` then runs the UI
only and their backend holds all persistence. `npm run dev` / `npm run mock`
still exist for anyone who prefers two terminals.

## Host: Render free tier
- One Docker container: FastAPI mock serves the API AND the built Vite bundle.
- Free tier constraints, accepted:
  - Spins down after 15 min idle, ~1 min cold start → warm the URL before
    sharing it with the client.
  - No persistent disk → the container's filesystem is ephemeral. See
    **Storage modes** below: `CUPEL_STORAGE=local` accepts that (every restart
    starts from the seed), `CUPEL_STORAGE=s3` replicates the SQLite file to a
    bucket so the demo's data survives.
- Phase 1 has no auth → gate with an unguessable URL + shared token checked
  by middleware (env var DEMO_TOKEN; ?token= or X-Demo-Token header).
- Upgrade path: Fly.io ~$2/mo machine + volume when always-on is wanted.
  AWS only if the client's org requires it, or for the Phase-3 Helm/k8s story.

## Storage modes (P2-PERSIST, 2026-08-06)
**SQLite is the database in both roles. Only the DURABILITY of the file
changes**, and it is selected by one environment variable:

| `CUPEL_STORAGE` | What it is | Who runs it |
| --- | --- | --- |
| `local` (default) | A plain SQLite file at `CUPEL_MOCK_DB`. No S3 code path, no extra env, no extra process. | Every developer checkout. Also the current, working Render default. |
| `s3` | The same SQLite file, continuously replicated to an S3-compatible bucket by [Litestream](https://litestream.io) and restored from it on boot. | The hosted demo, where the mock IS the whole backend and the disk is ephemeral. |

Nothing about the app changes between the two: the same FastAPI process, the
same schema, the same endpoints. `local` is exactly the behaviour that shipped
before this task.

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
4. Render dashboard → the `cupel-demo` service → **Environment** → add:

   | Variable | Value | Required |
   | --- | --- | --- |
   | `CUPEL_STORAGE` | `s3` | yes |
   | `CUPEL_S3_BUCKET` | `cupel-demo` | yes |
   | `CUPEL_S3_ENDPOINT` | `https://<account-id>.r2.cloudflarestorage.com` | yes |
   | `CUPEL_S3_ACCESS_KEY_ID` | R2 token access key id | yes |
   | `CUPEL_S3_SECRET_ACCESS_KEY` | R2 token secret | yes |
   | `CUPEL_S3_PATH` | key prefix inside the bucket (default `cupel-mock`) | no |
   | `CUPEL_S3_REGION` | `auto` for R2; the real region for AWS | no |

   Keep `CUPEL_SEED_ON_BOOT=1` and `CUPEL_SEED=42` — they now mean *seed if
   empty* (below), so they are safe to leave on with a durable database.
   These are secrets: set them in the dashboard, **not** in `render.yaml`.
5. Redeploy and check `GET /healthz`:
   `{"status":"ok", ..., "storage":{"mode":"s3","restored":true}}`.
   `restored:false` on the very first boot is correct (the bucket was empty);
   `"mode":"local"` when you asked for `s3` means the boot degraded — read the
   logs, `mock/boot.py` names the missing variable.

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
| A `CUPEL_S3_*` variable is missing | Logged with the exact variable names, and the container runs **local and unreplicated**. `/healthz` reports `mode:"local"`, so it never claims durability it does not have. |
| `litestream` binary missing | Same degradation, logged. (The image always ships it; this only bites a hand-rolled runtime.) |
| Replication falls behind / errors mid-run | Litestream logs and retries; the app is unaffected. |

`/healthz` is the fastest check — it reports the **effective** mode, not the
requested one. `npm start` prints the same thing in its banner.

### Running s3 mode on your machine (verification, not routine use)
`CUPEL_STORAGE=s3` plus the `CUPEL_S3_*` variables makes `npm start` boot
`python -m mock.boot` instead of uvicorn directly, and the banner names the
replica. You need the `litestream` binary on `PATH`. **Use a different
`CUPEL_S3_PATH` than the deployed demo** — see the single-writer rule.

## How to deploy (P1-TDEPLOY)
Everything ships in-repo: `Dockerfile` (stage 1 builds the Vite bundle, stage 2
supplies the pinned litestream binary, stage 3 runs the FastAPI mock serving
API + bundle), `render.yaml` (blueprint), `mock/boot.py` (picks the storage
mode), `mock/entrypoint.py` (boot: serve → wait /healthz → seed if empty).

1. Push the repo to GitHub, then either:
   - **Blueprint**: Render dashboard → New → Blueprint → pick the repo;
     `render.yaml` creates one free Docker web service with health check
     `/healthz`, `DEMO_TOKEN` auto-generated, `CUPEL_SEED_ON_BOOT=1`,
     `CUPEL_SEED=42`; or
   - **Manual**: New → Web Service → Docker runtime → free plan, health check
     path `/healthz`, and set those three env vars yourself.
2. On boot the container serves immediately and, **if the database comes up
   empty**, seeds itself deterministically through the public API (generator
   seed mode). A database restored from an s3 replica is left alone — see
   "Seed on boot = seed if empty".
3. Token gate usage: copy `DEMO_TOKEN` from the service's env and share the
   URL as `https://<app>.onrender.com/?token=<DEMO_TOKEN>`. The first
   `?token=` visit sets an httpOnly `cupel_demo_token` cookie, so the SPA and
   all subsequent same-origin API/asset requests pass without the query
   param. Machine callers send `X-Demo-Token: <DEMO_TOKEN>` instead
   (e.g. `python -m mock.generator drip --base https://<app>.onrender.com
   --token <DEMO_TOKEN>`). `/healthz` stays ungated for Render's checks.
   Unset `DEMO_TOKEN` = fully open (local dev default).
4. Local smoke without Docker: `npm run build`, then
   `DEMO_TOKEN=x CUPEL_SEED_ON_BOOT=1 python -m mock.entrypoint` and open
   `http://localhost:4010/?token=x`.

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
- Cost control: server-side max_tokens cap + simple rate limit so drip/replay
  can't burn the client's credit.
- No key present → canned mock responses as before (default).
