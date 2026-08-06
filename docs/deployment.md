# Phase-1 demo deployment (decided 2026-08-04)

## The same mock, two roles (P2-DEVSTART, 2026-08-06)
The FastAPI mock in `mock/` is used in two different ways — keep them apart
when reading this document:
- **On your machine**: the bundled DEMO BACKEND for local development. Boot it
  with the UI in one command — `npm start` — which reads `localMock
  {enabled, port, dbPath}` from `agentic.config.ts` (the one config artifact),
  passes `dbPath` as `SKEIN_MOCK_DB`, and prints the backend and its storage
  location at startup. Storage is a plain SQLite file on your filesystem
  (`mock/skein-mock.sqlite`, git-ignored). See README.md.
- **Deployed (this document)**: the mock IS the whole backend of the hosted
  demo — it also serves the built bundle from the same origin. Everything
  below is about that role.

Adopters connecting Skein to their own backend set `localMock.enabled: false`
and point `defaultTarget.dev` at their target; `npm start` then runs the UI
only and their backend holds all persistence. `npm run dev` / `npm run mock`
still exist for anyone who prefers two terminals.

## Host: Render free tier
- One Docker container: FastAPI mock serves the API AND the built Vite bundle.
- Free tier constraints, accepted:
  - Spins down after 15 min idle, ~1 min cold start → warm the URL before
    sharing it with the client.
  - No persistent disk → SQLite is ephemeral. Mitigation: mock re-seeds
    deterministically on boot (generator seed mode, fixed --seed), so a
    restart resets to seeded state — acceptable for the demo.
- Phase 1 has no auth → gate with an unguessable URL + shared token checked
  by middleware (env var DEMO_TOKEN; ?token= or X-Demo-Token header).
- Upgrade path: Fly.io ~$2/mo machine + volume when always-on / persistent
  demo data is wanted. AWS only if the client's org requires it, or for the
  Phase-2 Helm/k8s story.

## How to deploy (P1-TDEPLOY)
Everything ships in-repo: `Dockerfile` (stage 1 builds the Vite bundle, stage
2 runs the FastAPI mock serving API + bundle), `render.yaml` (blueprint),
`mock/entrypoint.py` (boot: serve → wait /healthz → seed).

1. Push the repo to GitHub, then either:
   - **Blueprint**: Render dashboard → New → Blueprint → pick the repo;
     `render.yaml` creates one free Docker web service with health check
     `/healthz`, `DEMO_TOKEN` auto-generated, `SKEIN_SEED_ON_BOOT=1`,
     `SKEIN_SEED=42`; or
   - **Manual**: New → Web Service → Docker runtime → free plan, health check
     path `/healthz`, and set those three env vars yourself.
2. On boot the container serves immediately and re-seeds itself
   deterministically through the public API (generator seed mode; chats
   dedupe on re-seed via client_message_id — runs/judgments may accrete
   across warm restarts, acceptable since the DB is ephemeral and a cold
   restart resets to seeded state).
3. Token gate usage: copy `DEMO_TOKEN` from the service's env and share the
   URL as `https://<app>.onrender.com/?token=<DEMO_TOKEN>`. The first
   `?token=` visit sets an httpOnly `skein_demo_token` cookie, so the SPA and
   all subsequent same-origin API/asset requests pass without the query
   param. Machine callers send `X-Demo-Token: <DEMO_TOKEN>` instead
   (e.g. `python -m mock.generator drip --base https://<app>.onrender.com
   --token <DEMO_TOKEN>`). `/healthz` stays ungated for Render's checks.
   Unset `DEMO_TOKEN` = fully open (local dev default).
4. Local smoke without Docker: `npm run build`, then
   `DEMO_TOKEN=x SKEIN_SEED_ON_BOOT=1 python -m mock.entrypoint` and open
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
