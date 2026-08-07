# Cupel TASKS — worked by the auto-runner, one task per fresh session
# Protocol per task (enforced by hooks + runner): implement → tests green → commit "P{phase}-T{id}: <summary>" → stop.
# Runner picks the first unchecked box. Do not start a task whose deps are unchecked.

## Phase 1 — serial spine
- [x] P1-T00 OpenAPI contract draft (all Phase-1 endpoints, /agenttrees/{tree}, envelope on turns, chat stream true/false)
- [x] P1-T18b Mock server core (FastAPI, SSE chat+tasks, SQLite, task lifecycle, both chat modes)  [deps: T00]
- [x] P1-T01 App shell + sidebar conversation list  [deps: T18b]

## Phase 1 — track A (chat)
- [x] P1-T02 Chat page SSE streaming  [deps: T01]
- [x] P1-T03 Turn actions (feedback/copy)  [deps: T02]
- [x] P1-T04 Composer + uploads  [deps: T02]
- [x] P1-T05 Chat settings submenu  [deps: T02]

## Phase 1 — track B (runs/agents)
- [x] P1-T09 Shared components (Picker/RunConfig/Comparison/Queue-panel/RunsList)  [deps: T01]
- [x] P1-T10 Agent tree view  [deps: T09]
- [x] P1-T10b Instruction editor (versions/diff/snapshots)  [deps: T09]
- [x] P1-T11a Context envelope capture + frozen replay default  [deps: T18b]
- [x] P1-T11 Runs 3-step flow  [deps: T09, T11a]
- [x] P1-T13 Turn forks + Open in Chat  [deps: T11, T02]
- [x] P1-T14 Fork comparison pivot  [deps: T13]
- [x] P1-T12b Basic eval (judge toggle, judgments, drawer)  [deps: T11]
- [x] P1-T20b Test in Runs (snapshot, last-selection)  [deps: T10b, T11]

## Phase 1 — track C (platform)
- [x] P1-T08 Task queue (SSE progress, cancel, retry)  [deps: T18b, T01]
- [x] P1-T18 Generator seed + basic drip  [deps: T18b]
- [x] P1-T16 Trace view  [deps: T18b, T02]
- [x] P1-T18c Live-LLM BYOK mode (OpenRouter passthrough in mock; X-LLM-Key/X-LLM-Model headers; key never persisted or logged; max_tokens cap + rate limit; see docs/deployment.md)  [deps: T18b]
- [x] P1-TRENAME Rename Loom → Skein (user decision; landing page updated separately)

## Phase 1 — close
- [x] P1-T15 Tune/Evaluate presets  [deps: T11]
- [x] P1-TEXPORT Editor: download version history to file (free-tier export; no contract change)  [deps: T10b]
- [x] P1-TDEPLOY Render demo deploy (Dockerfile: FastAPI serves built frontend + API; deterministic re-seed on boot; shared-token gate; see docs/deployment.md) (live Render service created from main session)  [deps: T18b, T01, T02]
- [x] P1-TE2E Smoke e2e + walk the Phase-1 DoD  [deps: all above]

## Phase 2 (expanded 2026-08-05, Phase 1 green; order per cupel-phases.md build order)
- [x] P2-CONFIG agentic.config.ts (one config artifact) + API client refactor onto it  [deps: Phase 1]
- [x] P2-T17 Backend switcher UI — Settings → Backend, sketch 09 (targets, healthz check, mock options)  [deps: CONFIG]
- [x] P2-T00 Contract v0.3.0 — extend openapi.yaml: auth, admin users/permissions/tree-toggle, eval workbench CRUD+import, generator control, memory (NO repo endpoints — pro tier); update contract tests  [deps: CONFIG]
- [x] P2-READY cupel-ready readiness script (validate a backend OpenAPI against the contract; mock's own OpenAPI = first conformance test)  [deps: T00]
- [x] P2-INIT cupel-ready --init — read a backend's OpenAPI, auto-detect base URL + prefix remap + auth scheme (requiresToken), emit ready-to-paste agentic.config.ts target block (user feature 2026-08-05)  [deps: READY]
- [x] P2-T07 Auth both AUTH_MODEs — mock JWT endpoints + seeded users, login screen, token handling/401s, /me both modes, no AUTH_MODE branches in components  [deps: T00]
- [x] P2-T07b/07c Admin — members permission matrix (view/tune/evaluate) + tree enable/disable (read-only history)  [deps: T07]
- [x] P2-SHARE Copy-link sharing — conversation ⋯ menu + turn action links (/chat/{id}?turn=), scroll+highlight on open, no-access state; works in both AUTH_MODEs via T07's return_to redirect (user feature 2026-08-05)  [deps: T07]
- [x] P2-T12 Eval workbench — cases/sets/rubrics CRUD, hand-crafted references, CSV/XLSX import (sketch 10)  [deps: T00]
- [x] P2-T12a Inspector + Casebooks (inspect role, audit-logged; casebook → eval set / replay suite)  [deps: T07, T12]
- [x] P2-MOBILE-SHELL Portrait shell fix — burger toggle, sidebar overlay closes on navigation, chat usable on phone; studio pages stay desktop-only (document in features.md)  [deps: none]
- [x] P2-FIXA Review bucket A — run-scoped latest_score bug, /tasks/stream tenant filtering, span-payload ownership check, markdown memo, chatSettings out of AppContext, grid cell memo, object-URL leak, streaming-draft isolation (see docs/review-2026-08-05.md)  [deps: none]
- [x] P2-DEVSTART One-command start + explicit local-mock flag — agentic.config.ts `localMock {enabled, port, dbPath}`; `npm start` boots UI + mock per the flag with a startup banner naming the backend AND its storage mode/location; adopters flip enabled:false and their own backend holds persistence (user decision 2026-08-06)  [deps: none]
- [x] P2-PERSIST Mock storage modes — CUPEL_STORAGE=local|s3; local = plain SQLite file (dev machine); s3 = Litestream continuous replication to an S3-compatible bucket (Cloudflare R2 or AWS) with restore-on-boot, for the hosted demo where the mock IS the whole backend on ephemeral disk. Seed-on-boot becomes seed-only-if-empty; document the single-writer constraint loudly; banner + /healthz report the active mode (user decision 2026-08-06)  [deps: none]
- [x] P2-CHATUX Chat feedback comment + clipboard paste — (a) 👍/👎 opens an optional comment box; the comment stores as Judgment.reasoning on the type:human judgment (additive contract change: FeedbackRequest.comment) and renders beneath that assistant turn, surviving reload; NOT a Turn (turns are what gets replayed/judged/traced — user agreed 2026-08-06). (b) paste images/files from the clipboard into the composer, reusing the existing /upload + chip flow (no onPaste handler exists today)  [deps: none]
- [x] P2-MSW Full MSW parity for unit tests
- [x] P2-E2E Full Playwright suite — 13 journeys × both auth modes, endpoint-tag interception  [deps: T07, T12, T17]
- [x] P2-RECORD Minimal e2e recording — Playwright `record` project (video:on, slowMo) + npm run e2e:record + ~30-line step-HUD banner helper; built-in HTML report = the review gallery. NO gif tooling/cursor/manifest/gallery (those are PRO-3 Reels)  [deps: none; richest after P2-E2E]
- ~~P2-T20 repo/PR~~ — PRO TIER, excluded from free build (user decision 2026-08-05); design stays in feature-spec only

## ══ Phase 2 is CLOSED. Next up, in this order (user decision 2026-08-07) ══

## Stage 0 — housekeeping. Small, mostly outside the code; do whenever convenient.
- [ ] PH-1 Rename the GitHub repo skein -> cupel. One command (`gh repo rename cupel`), but it
      moves the remote URL: re-point the local remote, and BOTH Render services (cupel-demo,
      cupel-site) clone from it — verify each still deploys afterwards. docs/index.html's
      quickstart already says github.com/LampOfSocrates/cupel, so today it is wrong
- [ ] PH-2 Sort out the Render URLs. The app service was renamed cupel-demo but its hostname is
      still skein.onrender.com (Render keeps the original); cupel-site.onrender.com is correct.
      Decide: live with the mismatch, recreate the service to get cupel-demo.onrender.com
      (loses the current URL), or put a real domain in front. cupel.io and cupel.sh are
      available; .dev/.app/.com are registered (.com is parked at a reseller)
- [ ] PH-3 Turn on demo persistence — the code shipped in P2-PERSIST but the hosted demo still
      runs CUPEL_STORAGE=local, so a restart wipes it. Needs an R2 (or S3) bucket + scoped
      token, then set CUPEL_STORAGE=s3 + CUPEL_S3_BUCKET / _ENDPOINT / _ACCESS_KEY_ID /
      _SECRET_ACCESS_KEY (+ optional _PATH, _REGION=auto) in the Render dashboard. NOTE the s3
      path has never actually executed (no Docker locally, binary blocked) — the first real
      deploy IS the test; /healthz storage.mode reports whether it degraded to local
- [ ] PH-4 Delete the SKEIN_* -> CUPEL_* env alias shim in mock/__init__.py. The Render
      dashboard is already updated, so it is dead weight carrying a delete-me note
- [ ] PH-5 Decide repo visibility. Both repos are private; going public is the whole point of
      the stars/community strategy, but the README and site should be launch-ready first

## Stage A — code quality + make-it-yours. Runs BEFORE the UX phase, no planning session
## needed: every item is already specified. Bucket B is docs/review-2026-08-05.md.
- [ ] PB-1 Split ChatPage.tsx (~1.1k lines, 20 hooks, four concerns) into ChatPage / Transcript+TurnBubble / Composer / ChatSettingsMenu / ByokSection. The OpenRouter key UI is not a chat setting  [bucket B1]
- [ ] PB-2 Extract useAsync(fn, deps) and apply at the ~12 hand-rolled useState(null)+useEffect+cancelled fetch sites; adopt SettingsPage's discriminated-union state shape. Deletes ~150 lines and forces ONE loading/error contract  [bucket B2, B7]
- [ ] PB-3 Untangle RunsPage navigation state — mode/step/prefilling/preset/testFlow has two sources of truth held together by two eslint-disable exhaustive-deps, plus a remount-by-key trick  [bucket B3]
- [ ] PB-4 Memoise list rows — memo(ConversationRow), pass activeId down instead of useParams() per row, same for ConversationPicker; useDeferredValue on both search inputs; virtualise past ~200 rows  [bucket B4]
- [ ] PB-5 Trace tree is O(n²) (TracePage filters all spans per node; min/max recomputed per render). AgentsPage already solves this correctly with a Map in useMemo — copy it  [bucket B5]
- [ ] PB-6 Strip task-ID archaeology from comments (files are 13-24% comments, mostly P1-T13 / not-built-here / T08's-job — history, not WHY, and already going stale). Keep every WHY comment  [bucket B6]
- [ ] PB-7 Split src/test/msw/handlers.ts (~2.5k lines, imported by 45 test files) — needs a shared state module + counters object first  [bucket B8]
- [ ] PB-8 Consider enabling the React Compiler — FIRST fix the three render-phase ref writes (App.tsx:35, App.tsx:112, QueueContext.tsx:83) that its lint rules reject  [bucket B9]
- [ ] PW-1 Whitelabel-lite — `npm run init` asks name / trees-label / backend URL and writes agentic.config.ts; wire product.label through every UI string so an adopter's name actually renders (user-approved 2026-08-05)

## Stage B — UX polish phase, desktop-first. PLANNED WITH THE USER before any task runs.
## Organising principle (strategy 2026-08-07): the wedge persona's first ten minutes,
## ending with THEIR agent answering in a real UI — not our demo with fake data.
## Known inputs:
##  - README/first-run must lead with "bring your own agent"; cupel-ready --init is the on-ramp
##  - NO tree switcher exists (raised by P2-T12a): the app has one active tree from config, so
##    cross-tree results (e.g. a casebook replay spanning trees) cannot be linked
##  - Coverage gaps (P2-RECORD): no visual-regression/snapshot testing at all; e2e films run
##    against the Vite dev server, never the built bundle Render serves; chromium only;
##    portrait filmed nowhere; BYOK live mode, CUPEL_STORAGE=s3 restore, a11y/keyboard paths
##    and SSE-drop/5xx surfaces untested
## Phase 3 begins only after Stage B closes and the user says so.

## Phase 3 — deferred features + ops (AFTER the full stop and the UX phase; user decision 2026-08-06).
## NOTE: this is NOT the original "Phase 3 = create-agentic-app scaffolder", which stays parked (see below).
## Contract support for CTX/GEN/MEM already shipped in v0.3.0 — those are implementation only.
- [ ] P3-T00 Contract v0.4.0 — review bucket C (15 items) PLUS two gaps found later: (i) the mock correctly returns 409 tree_disabled from six ops whose contract entries declare only 2xx/404 (POST agents, PUT instructions, POST snapshots, PUT last-selection, PATCH+DELETE conversation) — the contract under-declares; (ii) 422 is undeclared everywhere except /eval/cases/import while both implementations return it freely. Bucket C list (docs/review-2026-08-05.md): uniform cursor-paginated Page<T> collections, conversations without inlined turns, run-grid pagination+ETag, POST …/versions replacing non-idempotent PUTs, READABLE version history (GET + ?version= + …/versions for rubrics/sets/cases/snapshots — this is why the workbench can't show history today), GET /eval/cases, Idempotency-Key on 202s, SSE event ids + Last-Event-ID, /tasks/stream subscription filters, per-operation permission semantics + 403s, Error.details[]/request_id + 422/429/503, batch turn fetch, Health.contract_version + capabilities, visible soft-delete, search semantics, span retention. RUNS FIRST IN PHASE 3 — the CLIs generate/consume from the contract, so bump it before they ship (user agreed 2026-08-06)  [deps: Phase 2 complete]
- [ ] P3-DOCS Persistence guidance — review bucket D: write docs/persistence.md (Postgres spine w/ partitioning+indexes, object storage for span payloads & attachments, ClickHouse/OTLP for span metadata, durable workflow engine for the task queue, Redis for SSE fan-out + idempotency), add the "good shape, do NOT copy the physical layer" header to mock/db.py, and add a tenant/owner column to the reference schema. Pairs with the backend scaffolder, which must point at it (user agreed 2026-08-06)  [deps: none; before P3-CLI]
- [ ] P3-CTX Context policy widening — frozen/today/custom + fallback for envelope-less turns + recorded-tools playback (extend sketch 03)  [deps: P2-T00]
- [ ] P3-GEN Generator control API + Settings drip-rate controls (un-greys the mock-options placeholders from P2-T17)  [deps: P2-T00, P2-T17]
- [ ] P3-MEM Memory panel — view/edit/clear per tree, compaction as a visible queued task  [deps: P2-T00]
- [ ] P3-K8S k8s manifests + Helm post-upgrade Playwright job that gates the release (artifacts + local validation; no live cluster)  [deps: P2-E2E] (moved from Phase 2 by user decision 2026-08-06)
- [ ] P3-CLI2 cupel-cli — terminal client to ANY conformant backend: `cupel-cli --mybackend XXXX <cmd>`; chat with live token streaming, conversations/agents/instructions/replay/run --watch/judge/trace/tasks --watch, `--json` for scripts, delegates `ready` to the existing comparator. In cli/cupel-cli/. PLAN: docs/plan-cupel-cli.md (4 sub-tasks A-D; 3 open questions). (user decision 2026-08-06)  [deps: all Phase 2, after the UX phase]
- [ ] P3-CLI agentic-app-maker — `cupel create-agentic-app|ui|backend --name X --same-repo --gap-as-mock server --mybackend <openapi>` in cli/agentic-app-maker/; generates a runnable project + prints test/run/change-my-backend next steps; no backend given = mock does everything. PLAN: docs/plan-agentic-app-maker.md (5 sub-tasks A-E; 5 open questions need answers BEFORE building). Un-parks the original scaffolder; may absorb P4-HYBRID (see plan §1, Q1). (user decision 2026-08-06)  [deps: all Phase 2, after the UX phase]

## ══ THERE IS NO PAID TIER (user decision 2026-08-07 — supersedes all earlier tiering) ══
## Goal is not revenue: brand, GitHub stars, getting hired, a community project, and
## out-competing funded startups with free open source. Nothing is held back, ever.
## The old "Phase 4 pro shelf" is dissolved — its items are ordinary free roadmap work below.

## Phase 4 — the rest of the roadmap (free, like everything else)
- [ ] P4-REPO Agents as Code — GitHub connect, instruction changes as PR diffs, merge promotes the version live; mock git server. No free tool does this; it is a headline differentiator, not a paywall (former P2-T20)
- [ ] P4-SHARE Public sharing — anonymous tokenised share links for conversations/turns, with expiry and revocation. A growth mechanism: every shared conversation is a billboard (extends the in-app deep links from P2-SHARE)
- [ ] P4-AGUI AG-UI bridge — DECISION REQUIRED BEFORE BUILDING. Spike done (docs/spike-agui.md, commit ee9538f): recommends adopt-partially via mock/agui.py on the existing `adapter?:` seam (~400-600 LOC, 1-2 weeks) — a server implementing our contract that proxies generation to any AG-UI endpoint. NOT a client transport, NOT a contract change. Open question the spike could not settle: also ship a thin client-side adapter behind a loud "nothing is persisted" banner, to avoid reading as "does not support AG-UI"? Re-read the spike's "what would change my mind" issue list (persistence #2159/#2186/#1160, resumability #2105/#2106, token usage w/ spend #2188, foundation donation + 1.0) before deciding — the answer may have changed by then  [deps: P3-T00 contract v0.4.0]
- [ ] P4-HYBRID Hybrid backend fill — per-feature-family routing: implemented endpoints → the user's backend, missing families → the bundled mock, table derived from the cupel-ready gap report; visible "served by mock" badges; demo-quality only (no cross-store data joins). Lowers adoption cost for the wedge persona
- ~~P4-REELS~~ — MOVED OUT 2026-08-07 to its own project: C:\Users\soura\Code\2026\journey-replayer (spec committed there). This repo stays a clean agentic chat + studio app. What remains here is P2-RECORD's minimal recording rig, which is enough for our own suite.

## Parked indefinitely: a hosted multi-tenant platform. Not on any roadmap.
## Review buckets: B = the UX phase · C = a future contract v0.4.0 · D = persistence docs.
## Strategy (2026-08-07): wedge persona = the framework builder with an agent and no UI;
## positioning = "the console for agents you already built"; AG-UI stance pending a spike;
## product name settled 2026-08-07: Skein → Cupel (second and final rename; the repo,
## the mock, the contract metadata and the docs all say Cupel. The local directory and
## the GitHub remote are renamed separately by the user).
