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
- 2026-09-04: Evaluations step 1 rebuilt to the handoff, read off Cupel.dc.html rather than
  the README: the split INVERTS (grid collapses to a 46px ribbon on first pick, panel takes
  the width), Selected panel with group/turn ✕ and a docked In/Out pane. Selection rules
  extracted to one tested module — two surfaces mutate the same set and the narrowing case
  ("all" minus one turn = every OTHER turn) is the one they would implement differently.
  The picker is controlled now; collapse is derived, not stored.
- 2026-09-04: Feedback records WHO left it. Scorer.ref carries the rater's user id for
  kind human (it already carried the rubric id for kind llm, so scorer_ref now filters
  "everything this person scored" for free) + a denormalized display_name, because
  /admin/users is the only name lookup and it is admin-gated. Server resolves rater as
  verified user → the conversation's owner → nobody; existing rows backfilled the same way,
  which is why the demo shows six personas instead of Dev User on every line.
- 2026-09-03: Studio ▸ Feedbacks built — the triage side of the thumbs-down loop, one
  request (scorer_kind=human + tree), note + turn id + jump-to-conversation.
- 2026-09-03: App shell to the handoff — top bar (title + subtitle + Work pill) and a docked
  Work queue. Titles travel up via PageHeaderContext, so Chat and Studio stopped printing
  their own. ETA is derived from the task's own rate and SUPPRESSED when implausible.
- 2026-09-03: Contract v0.7.0 — listJudgments gains `scorer_kind` and `tree`; Judgment gains
  nullable `conversation_id`. Additive, but a MINOR bump on purpose: ignoring an unknown
  query param is conformant, and here that failure is silent and wrong.

## Next
- Design handoff, screens still to do (tokens, shell, Evaluations step 1 are done):
  Evaluations step 2 (picked ribbon, sub-agent prompt editor with per-run draft semantics,
  Run setup pane) and step 3 (table / side-by-side), the dense conversation grid with turn
  expansion for Studio ▸ Conversations, Chat 3-column, Traces 216/flex/296.
- Studio ▸ Feedbacks: list, rater and jump built. Still missing its two ACTIONS — publish
  as a new instruction version, and re-run similar turns (pre-seed an Evaluations run).
- Memory panel (task 12): view/edit/clear per tree; 4 contracted-but-unbuilt operations
  (GET/PUT/DELETE /agenttrees/{tree}/memory, POST .../memory/compact).
- docs/persistence.md (task 13): document intended physical storage layout (Postgres,
  object storage, ClickHouse/OTLP, Redis) — guarded as "do NOT copy" reference, not the mock's.
- UX phase planning session (task 17): desktop-first flow for a user bringing their own agent.
- Generator control API (task 23): POST/GET /admin/generator endpoints to un-grey settings UI.
- k8s manifests + Helm post-upgrade Playwright gate (task 24), artifacts/local validation only.
