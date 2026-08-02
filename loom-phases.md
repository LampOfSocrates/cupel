# Loom — 4-Phase Build Plan (for Claude Code)

> Companion to `feature-spec.md` (the what) and `react-migration.md` (the anti-hallucination rules). Work phases in order; within a phase, follow the task order given. Session opener for every Claude Code session:
>
> *"Read react-migration.md, feature-spec.md, and loom-phases.md. We are in Phase N, task X. Quote the relevant spec lines before writing code. Cite file:line for claims about existing code. Do not build features from later phases."*

---

## Phase 1 — Clone & Run
**Goal**: one complete working instance. Users clone, `npm run dev`, get a full studio on the bundled mock, run app simulation. Backend URL is a hand-edited constant. No auth (dev user). DIY deployment.

### What you'll be able to do
- **Chat with an agent** and watch the reply stream in, then thumb it up/down, copy it, fork it, or open its trace — using the Chat screen (sketch 01)
- **Attach images and files** to a message, remove them before sending, and stop a generation mid-stream — using the composer (sketch 01)
- **Find any past conversation** by search or recency, and see forked conversations nested under their parent — using the sidebar list (sketch 07)
- **See your agent tree as a diagram** — every agent, its live version and tools — and click any node to edit it or add a sub-agent under it — using the Agent tree view (no sketch; reuses trace nodes)
- **Edit an agent's instructions safely**: every save is a new version, with diff view and rollback, never an overwrite — using the Instruction editor (sketch 06)
- **Test an instruction change in one click**: "Test in Runs" snapshots your draft and replays your usual conversations against it — using the editor → Runs flow (sketches 06 → 03)
- **Replay stored conversations — or a single turn — under a different instruction version, model, or endpoint** — using the Runs stepper: pick (sketch 02), configure (sketch 03), compare (sketch 04)
- **Re-fire one turn against several endpoints at once**, each becoming a real new conversation you can open and continue in Chat — from any results cell or any chat turn (sketches 04, 01)
- **Compare outputs side by side** — baseline vs each config, cells filling in live as tasks finish — using the comparison grid (sketch 04)
- **Optionally score runs with an LLM judge** and read its reasoning per turn, with every past score kept forever — using the judge toggle (sketch 03) and judgment drawer (unsketched)
- **Watch every background job's live progress** — per-conversation, per-turn — cancel batches, retry just the failures — using the task queue panel (sketch 05)
- **Debug any turn**: see the full agent → tool → LLM call flow with time, tokens in/out, and cost per step, and open any step's actual prompt/response — using the Trace view (sketch 08)
- **Trust that replays mean what they say**: every turn records its context (date, timezone, region) at generation, and replays run under that original context by default — using the envelope shown in the trace header
- **Run the whole app with no backend**: the bundled Python mock serves everything (chat in both streaming and non-streaming modes), and **`npm run simulate` makes the app fill itself** with realistic conversations, runs, and scores

### UI sketches to build against (`sketches/` = annotated with endpoint tags for wiring; `sketches/clean/` = dense annotation-free versions — **match the clean set's density**)
| Sketch | Screen |
|---|---|
| 01-chat.svg | Chat window, turn actions, composer |
| 02-select-turns.svg | Runs step 1 — picker with turn checkboxes |
| 03-config.svg | Runs step 2 — Run Config drawer, judge collapsed |
| 04-results.svg | Runs step 3 — comparison grid, incremental fill |
| 05-queue.svg | Task queue panel, parent/child progress |
| 06-editor.svg | Instruction editor, versions + diff |
| 07-conversations.svg | Sidebar recent list, fork nesting |
| 08-trace.svg | Trace — call tree + waterfall + span drawer |

(Agent tree view: reuse 08's node components, structure-only — no separate sketch.)

### Mock deliverables (Phase 1)
`/mock` (FastAPI): all Phase-1 endpoints tree-scoped under `/agenttrees/agent1` + second tree `agent2`; SSE for chat + `/tasks/stream` + trace spans; **chat runs in both modes** — `stream: true` (SSE token stream, the UI default) and `stream: false` (single JSON response, for curl/scripts/backends that can't stream) — same endpoint, flag in the request body, and the UI degrades gracefully to non-streaming when the SSE toggle is off in mock options; stateful task lifecycle (queued→running→done, children); SQLite file persistence; snapshot→version promotion; fork creation with lineage; append-only judgments; seed data via generator `seed` mode (deterministic `--seed`); `drip` basic loop. Run: `npm run mock` (wraps `uvicorn`), `npm run simulate` (seed + drip).

### Test deliverables (Phase 1)
Unit tests (Vitest + MSW handlers) for API client, queue store, comparison grid fill; one smoke e2e (`npm run e2e:smoke`): boot on mock → send chat turn (SSE renders) → queue a 2-conversation replay → grid fills → judge one → score appears.

### Runnable at end of Phase 1
```
npm install
npm run mock        # Python (FastAPI) mock on :4010, seeded — serves chat in
                    # both streaming (SSE) and non-streaming (JSON) modes
npm run dev         # studio on :5173 against it
npm run simulate    # drip: app fills itself
npm run e2e:smoke
```
= a complete, self-demonstrating frontend + backend pair.

### Build order (from feature-spec dev prompts)
Serial: API contract draft → mock server core (#18b minimal) → shell (#1)
Then parallel tracks: A) Chat #2–5 · B) shared components #9 → tree view #10 → editor #10b → Runs #11 → forks #13/#14 → eval basics #12b · C) queue #8, generator #18 (seed+basic drip), trace #16
Last: presets #15, smoke e2e.

### Definition of done
Clone → `npm run dev` → app boots on mock with seeded data → simulate (drip) fills sidebar/queue live → full loop works: chat → fork a turn to 2 endpoints → compare → judge → read reasoning → edit agent → Test in Runs → see trace with costs.

---

## Phase 2 — Integrate & Test
**Goal**: point Loom at real backends, prove conformance, harden. Clone → run simulation → edit ONE file to add backends.

### What you'll be able to do
- **Point Loom at your own backend by editing one file** (`agentic.config.ts`) and switch between mock/local/staging/prod live — using Settings → Backend (sketch 09)
- **Check whether your backend is ready before you try**: run `npx loom-ready <your-openapi>` and get a report of every missing endpoint or mismatched shape
- **Connect backends whose routes are named differently** (e.g. `/nabu-service/…`) via remap, or **any backend at all** via a small adapter module — with the mock filling in whatever your backend doesn't do yet
- **Turn auth on or off with one env var**: off = instant dev as a chosen user; on = real login, tokens, and 401 handling — using the login screen (unsketched) and the same UI code either way
- **Control who sees and edits which agent tree** with a per-tree view/tune/evaluate matrix, and **disable a whole tree** (new work blocked, history kept read-only) — using Settings → Members and Settings → Agent trees (unsketched)
- **Inspect every conversation in the system as a super user** — filter by user, tree, date, or score in a dense keyboard-driven table with an inline transcript reader — using the Inspector (unsketched; requires the `inspect` role, audit-logged)
- **Collect noteworthy turns into Casebooks** with one keystroke, then turn a casebook into an eval set, a replay regression suite, or few-shot examples for an agent — using the ⊞ action and Casebook view (unsketched)
- **Hand-craft expected answers and have the judge score AI against them** — type/paste references, pull them from real turns or forks, or **bulk-import a spreadsheet** of input/expected pairs — using the Eval workbench (sketch 10)
- **Choose the context a replay runs under** — frozen original / today / custom — with a fallback setting for turns that recorded none ("when context is unclear, use X"), and **replay recorded tool results** so only your change varies — using the Context policy + Tools mode in Run Config (extend sketch 03)
- **Watch a turn's trace draw itself live while the agent is still responding**, and compare traces across versions to see why one is slower or pricier
- **Configure agents as ADK YAML**: per-agent `format: text | yaml`, with syntax highlighting and Google ADK schema validation that blocks bad saves in the editor; the YAML's `model:` rules live traffic while Run Config can override it per-run — using the editor's YAML mode (clean sketch 06)
- **Manage agents like code**: connect a GitHub repo, open a PR whose diff *is* the instruction change, and have merging the PR promote that version live — using the editor's Open PR flow and Settings → Repo (unsketched)
- **See and control what the app remembers about your conversations** per agent tree — view, edit, or clear the memory document; compaction runs as a visible queued task — using the Memory panel (unsketched)
- **Keep the app perpetually filled**: tune the generator's drip rates ("N conversations/hour, fail 5%") — using the generator controls in Settings (extend sketch 09)
- **Trust every deploy**: `helm install` puts the app + mock in one pod and fires a Playwright suite that walks all 13 user journeys in both auth modes — a failing suite blocks the release

### UI sketches to build against
| Sketch | Screen |
|---|---|
| 09-settings.svg | Backend switcher, healthz, mock options |
| 10-eval-workbench.svg | Eval workbench — cases/sets/rubrics, reference editing, CSV import |

Plus new-in-Phase-2 screens with no sketch yet (derive from spec + existing visual language): login, Settings → Members matrix, Settings → Agent trees toggles, Settings → Repo, Memory panel, generator controls (extend 09), Inspector + Casebook view, judgment drawer, login/Members/tree-toggles. Claude Code: propose each layout as a description first, get approval, then build.

### Mock deliverables (Phase 2)
Mock extends to FULL contract: auth endpoints in both `AUTH_MODE`s (seeded `admin@demo`/`restricted@demo`, real-shaped JWTs), admin users/permissions/tree-toggle, eval workbench CRUD, repo endpoints backed by a **mock git server** (branch/PR/merge webhook), generator control API, failure/latency injection env vars. Ships its own OpenAPI file — which the readiness script validates against Loom's contract as the first conformance test.

### Test deliverables (Phase 2)
Full Playwright suite: checklist items 1–13 (shell, chat, runs, forks, judge, queue, editor, trace, backend switcher, permissions, tree disable, auth suite ×2 modes, authoring/PR loop), request-interception asserting the endpoint tags from the sketches; full MSW parity for unit tests; k8s manifests (pod: app + mock sidecar) + Helm post-upgrade Playwright Job (fail = block release, report artifact); `npx loom-ready` in CI.

### Runnable at end of Phase 2
```
npm run mock && npm run dev          # as Phase 1, now full contract
npm run e2e                          # full suite, both auth modes
npx loom-ready http://localhost:4010/openapi.json   # conformance: PASS
# edit agentic.config.ts → add your backend → switch target in Settings
helm install loom ./chart            # pod boots, e2e Job gates it
```
= production-shaped app: real-backend ready, auth on/off, fully tested, k8s-deployable.

### Build order
config + API client refactor → switcher UI → readiness script → auth #7 → permissions #7c + tree admin #7b → eval workbench #12 → repo integration (#20 repo parts) → e2e suite + k8s harness #19b → MSW parity → generator controls.

### Definition of done
Readiness script passes against the mock's own OpenAPI; a remapped backend (`/nabu-service/*`) chats successfully; e2e green in both auth modes; k8s deploy runs the hook Job and gates on failure; a PR round-trip promotes a version.

---

## Phase 3 — Scaffold (create-agentic-app)
**Goal**: `npx create-agentic-app my-studio --trees-label Assistants --api contract --features no-evaluate` → trimmed, prefilled, git-initialized, mock-seeded copy; `npm run dev` ready.

### What you'll be able to do
- **Spin up your own studio in one command**: `npx create-agentic-app my-studio --trees-label Assistants --api contract` — trimmed repo, config prefilled, git ready, mock seeded
- **Ship only what you need**: `--features no-evaluate` removes the menus, the routes, and the code bundles
- **Call agent trees whatever your org calls them** — one config key relabels the whole UI
- **Create a new agent by describing it in a sentence**: AI drafts the instructions, suggests where it sits in the tree and which tools it needs — using the New-agent wizard (unsketched)
- **Refine instructions with an AI copilot** that proposes changes as diff hunks you accept or reject one by one — using the copilot panel in the editor (unsketched)
- **Get a test suite for free**: "gen evals" reads the instructions and generates eval cases + a rubric, so a brand-new agent is scoreable at minute one
- **Have the app compact conversations into real memory**: LLM summarization merges what matters into the tree's memory document on a schedule, on conversation close, or on demand
- **Do everything from the terminal**: `loom chat` with your favorite agent (`loom fav refunds`), `loom edit / test / replay / judge / trace / tasks --watch / memory / pr` — same API as the UI, `--json` for scripts, works against any conformant backend
- Template repo hygiene: no monorepo internals, clean README quickstart (4 steps), CI template included

### Definition of done
Scaffold a project with 2 flags changed → boots on mock → author a new agent via wizard → gen_evals → Test in Runs → all without touching a config file by hand.

---

## Phase 4 — Hosted Loom
**Goal**: Loom itself runs as a hosted multi-tenant platform (AWS-class infra).

### What you'll be able to do
- **Use Loom without installing anything**: a hosted, multi-tenant instance with SSO, org isolation, and org-level member + tree administration
- **Customise Loom in the browser and take it home**: rename, rebrand, pick features and routes in a live preview (it's the real app on the hosted mock), then download a zip, push to your GitHub, or one-click deploy — using the "Make it yours" configurator (unsketched)
- **Show it off with zero setup**: the public demo fills itself continuously via the always-on generator
- **Bring other agent frameworks**: CrewAI, LangGraph and similar config schemas plug into the editor's validation layer (deliberately deferred here — Phase 2 ships ADK only)
- **Certify your backend**: point the hosted conformance service at your API and get a readiness + e2e report card
- **Operate it like a product**: metrics and alerts on queue depth, SSE health, generator liveness; per-org quotas
- (Output of the configurator ≡ Phase 3 scaffold output — one artifact rule holds)

### Definition of done
A stranger customises on the hosted site, pushes to their GitHub, deploys, and points it at their own backend using only Phase 2 mechanisms.

---

## Cross-phase rules (every Claude Code session)
1. Never build ahead of the current phase; if a task needs a later-phase mechanism, stub it and flag it.
2. Quote spec lines before coding; cite file:line about existing code; check lockfile versions before using library APIs.
3. Invariants that must never break, any phase: versions/judgments/snapshots are append-only · generator writes only through the public API · `/me` is always called · no component branches on AUTH_MODE · one config artifact across all layers.
4. Every phase ends green: its DoD walked end-to-end against the mock, and (Phase ≥2) the e2e suite passing.
