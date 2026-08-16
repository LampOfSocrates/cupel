## What this is
Cupel is a self-hosted chat client + agent studio: versioned instructions, replay/compare,
an LLM judge, and cost-tracked traces for agents you already built. React/Vite frontend,
backend-agnostic via a single `agentic.config.ts` + `openapi.yaml` contract.

## Where it runs
- Local dev: `npm start` — UI on :5173, bundled FastAPI demo backend (`mock/`) on :4010,
  SQLite storage.
- Hosted demo: cupel-site.onrender.com (Render), demo at cupel-site.onrender.com/cupel-demo/.
  Render mode uses `CUPEL_STORAGE=s3`, SQLite replicated to R2 via Litestream.

## Features
- Chat UI (SSE streaming) + studio: evaluations, comparison grids, traces, instruction editor.
- BYO-backend: point `agentic.config.ts` at your own API; Cupel stores no server state itself.
- `openapi.yaml` is the single source of truth/contract (67 operations, grouped by family).
- `cupel-ready` CLI checks a backend's readiness against the contract.
- Demo data generator/simulator, tree switcher for multiple agent trees.

## Recently tried
- 2026-08-11: Removed docs/feature-spec.md entirely; openapi.yaml absorbed all its content
  so the contract is now self-contained (300+ dangling cross-references cleaned up).
- 2026-08-11: docs/deployment.md rewritten from real operating experience — env var changes
  on Render don't restart the service; CUPEL_S3_PATH is required in practice though optional
  in code; restored:true doesn't mean current data.
- 2026-08-11: Task list pruned to open work only (task numbers stable, closed ones removed,
  not tracked in code comments).
- 2026-08-11: Contract bumped to v0.6.0; docs/index.html re-themed to Claude-style palette
  (IBM Plex fonts, warm palette).
- 2026-08-11: Tree switcher wired to real setTree/Sidebar Select, respecting AgentTree.enabled.

## Next
- Memory panel (task 12): view/edit/clear per tree; 4 contracted-but-unbuilt operations
  (GET/PUT/DELETE /agenttrees/{tree}/memory, POST .../memory/compact).
- docs/persistence.md (task 13): document intended physical storage layout (Postgres,
  object storage, ClickHouse/OTLP, Redis) — guarded as "do NOT copy" reference, not the mock's.
- UX phase planning session (task 17): desktop-first flow for a user bringing their own agent.
- Generator control API (task 23): POST/GET /admin/generator endpoints to un-grey settings UI.
- k8s manifests + Helm post-upgrade Playwright gate (task 24), artifacts/local validation only.
