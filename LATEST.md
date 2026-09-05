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
- 2026-09-05: Step 3 stat tiles — average / better / worse / thumbs-down, each stated as a
  CHANGE against the baseline column. Needed a contract addition: ScorerScoreSummary gains
  by_column (same figures per grid column, 0 = baseline), since a client could otherwise
  only show the run's overall mean, the one number that answers nothing. Better/worse is
  per-ROW from the grid, which no aggregate can recover. No tile is invented: nothing
  scored, no tiles.
- 2026-09-04: Evaluations step 2 — picked ribbon (turn cards, fetched only when opened) and
  the sub-agent instruction editor. A per-run edit is a SNAPSHOT minted at Queue, never an
  instruction version: the live one stays live. One override per run, because Variant holds
  a single agent_id + snapshot_id — the UI says so before the fact rather than sending
  something narrower than the screen implies. Fixed a bug this exposed: the dump helper
  only understood paged collections, so listAgents (a bare array) dumped empty and
  browser.ts then REPLACED the fixture agents with nothing.
- 2026-09-04: Feedbacks' two actions close the handoff's core loop — "publish an
  instruction change" (to the agent's editor, resolved through the conversation since a
  judgment names only a turn) and "re-run similar turns" (a seedSelection handoff that
  lands on step 1 with that turn picked, because the point is to WIDEN one complaint).
  Both are handoffs, not in-place writes: nothing here knows what the new instruction
  should say, and the note does not say either.
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

## Next
- Design handoff, screens still to do (tokens, shell, Evaluations steps 1-2 are done):
  the Run setup pane's 380↔560 expand toggle, the dense conversation grid with turn
  expansion for Studio ▸ Conversations, Chat 3-column, Traces 216/flex/296.
  (Evaluations steps 1-3 are done.)
- Multi-agent instruction overrides are NOT expressible: Variant carries one agent_id +
  snapshot_id, so a run overrides one agent. The design's editor implies several.
- Studio ▸ Feedbacks: done except "versions sourced from feedback are visibly marked as
  such" — InstructionSave carries no provenance field, so that needs a contract change.
- Memory panel (task 12): view/edit/clear per tree; 4 contracted-but-unbuilt operations
  (GET/PUT/DELETE /agenttrees/{tree}/memory, POST .../memory/compact).
- docs/persistence.md (task 13): document intended physical storage layout (Postgres,
  object storage, ClickHouse/OTLP, Redis) — guarded as "do NOT copy" reference, not the mock's.
- UX phase planning session (task 17): desktop-first flow for a user bringing their own agent.
- Generator control API (task 23): POST/GET /admin/generator endpoints to un-grey settings UI.
- k8s manifests + Helm post-upgrade Playwright gate (task 24), artifacts/local validation only.
