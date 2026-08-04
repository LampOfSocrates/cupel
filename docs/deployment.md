# Phase-1 demo deployment (decided 2026-08-04)

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
