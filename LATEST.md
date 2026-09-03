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
- 2026-09-03: Studio ▸ Feedbacks built — the triage side of the thumbs-down loop, one
  request (scorer_kind=human + tree), note + turn id + jump-to-conversation. NOT shown:
  who left it — Judgment.scorer for a human is all-null, so there is no rater identity.
- 2026-09-03: App shell to the handoff — top bar (title + subtitle + Work pill) and a docked
  Work queue. Titles travel up via PageHeaderContext, so Chat and Studio stopped printing
  their own. ETA is derived from the task's own rate and SUPPRESSED when implausible.
- 2026-09-03: Contract v0.7.0 — listJudgments gains `scorer_kind` and `tree`; Judgment gains
  nullable `conversation_id`. Additive, but a MINOR bump on purpose: ignoring an unknown
  query param is conformant, and here that failure is silent and wrong.
- 2026-09-03: Theme re-cut to the handoff's own tokens. The palette already matched; the TYPE
  did not — the previous pass chased "roomier, larger type" (13–22px) where the handoff pins
  9.5–12px and says so. Now 10/11/11.5/12/16px, flat headings, shadows off, sidebar 190px.
- 2026-09-03: MSW now drives the BROWSER — `npm run dev:msw`, no Python. Demo volume from
  src/test/msw/mockdata.ts (`npm run dump:mockdata`); tests keep their small fixtures. Found
  two bugs: the conversations handler never scoped by tree_id, and `.env.msw` was gitignored.

## Next
- Design handoff, screens still to do (tokens + shell are done): dense conversation grid
  with turn expansion, Evaluations step 1 (selection model, Selected panel, In/Out pane,
  ribbon collapse) and step 2 (sub-agent prompt editor with per-run draft semantics),
  step 3 table/side-by-side, Chat 3-column, Traces 216/flex/296.
- Studio ▸ Feedbacks: list + jump built. Still missing its two ACTIONS — publish as a new
  instruction version, and re-run similar turns (pre-seed an Evaluations run).
- Memory panel (task 12): view/edit/clear per tree; 4 contracted-but-unbuilt operations
  (GET/PUT/DELETE /agenttrees/{tree}/memory, POST .../memory/compact).
- docs/persistence.md (task 13): document intended physical storage layout (Postgres,
  object storage, ClickHouse/OTLP, Redis) — guarded as "do NOT copy" reference, not the mock's.
- UX phase planning session (task 17): desktop-first flow for a user bringing their own agent.
- Generator control API (task 23): POST/GET /admin/generator endpoints to un-grey settings UI.
- k8s manifests + Helm post-upgrade Playwright gate (task 24), artifacts/local validation only.
