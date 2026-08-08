# Open items — single source of truth

Compiled 2026-08-08 from a full sweep of TASKS.md, docs/review-2026-08-05.md, the four
plan docs, docs/spike-agui.md, the product docs, and code-level markers. **Do not re-scan
those sources to find open work — read this file.** TASKS.md stays the auto-runner's
queue (it owns the per-task protocol and dep order); this file is the deduped index of
everything open, including items TASKS.md does not track.

Baseline at compile time: `master`, 542 vitest tests green across 46 files, tree clean.

---

## Closed — do not re-investigate

- **Phase 1 and Phase 2**: complete. Every box checked.
- **Review bucket A** (8 items): all verified fixed in code, not just marked done.
  Exception below.
- **Auto-judge fragility** (raised by P2-RECORD): fixed 2026-08-07, commit `3936794`.
  Rule is now "done + judge in config + not already judged", read from the append-only
  store. Do not re-plan it. One residual, tracked as C6 below.
- **PH-1 repo rename**: done 2026-08-08. Repo is `LampOfSocrates/cupel`, local remote
  re-pointed. This also made `docs/index.html`'s clone URL correct.
- **Product name**: settled. Loom → Skein → **Cupel**, final. No "Skein"/"Loom" strings
  survive in the product docs; see D-6 for the two that survive elsewhere.
- **Paid tier**: there is none, ever (2026-08-07). Supersedes all earlier tiering. The
  old "Phase 4 pro shelf" is dissolved; its items are ordinary free roadmap work.

---

## Stage 0 — housekeeping

| id | item | status |
|---|---|---|
| PH-2 | Render hostname is `skein.onrender.com`, not `cupel-demo.onrender.com`. `render.yaml:11` already says `name: cupel-demo`; Render pins the hostname minted at creation. Fixing it means deleting the service and re-applying the blueprint. **Carry over `DEMO_TOKEN` first** (`generateValue: true`, so a new service mints a different one and shared demo links die), and note the old hostname dies instantly with no redirect. | dashboard-only, user |
| PH-3 | Turn on demo persistence. Code shipped in P2-PERSIST but the hosted demo still runs `CUPEL_STORAGE=local`, so a restart wipes it. Needs an R2/S3 bucket + scoped token, then `CUPEL_STORAGE=s3` + `CUPEL_S3_BUCKET` / `_ENDPOINT` / `_ACCESS_KEY_ID` / `_SECRET_ACCESS_KEY` (+ optional `_PATH`, `_REGION=auto`). **The s3 path has never once executed** — the first real deploy IS the test; `/healthz` `storage.mode` reports whether it degraded to local. | deferred, needs user credentials |
| PH-4 | Delete the `SKEIN_*` → `CUPEL_*` env alias shim in `mock/__init__.py:3`. Render dashboard is already on `CUPEL_*`, so it is dead weight carrying a delete-me note. | ready, safe |
| PH-5 | Decide repo visibility. Both repos private; going public is the point of the stars/community strategy, but README + site should be launch-ready first. | deferred, user decision |

---

## Stage A — code quality + make-it-yours

Runs before the UX phase. Every item is already specified; no planning session needed.
The `[Bn]` tags are the corresponding review-bucket-B item — **same item, not a duplicate.**

| id | item |
|---|---|
| PB-1 | Split `ChatPage.tsx` (~1.4k lines, ~20 hooks, four concerns) into ChatPage / Transcript+TurnBubble / Composer / ChatSettingsMenu / ByokSection. The OpenRouter key UI is not a chat setting. `[B1]` |
| PB-2 | Extract `useAsync(fn, deps)` and apply at the ~12 hand-rolled `useState(null)`+`useEffect`+cancelled-fetch sites; adopt SettingsPage's discriminated-union state shape. Deletes ~150 lines, forces one loading/error contract. `[B2, B7]` |
| PB-3 | Untangle RunsPage navigation state — `mode`/`step`/`prefilling`/`preset`/`testFlow` has two sources of truth held together by two `eslint-disable` exhaustive-deps plus a remount-by-key trick. `[B3]` |
| PB-4 | Memoise list rows — `memo(ConversationRow)`, pass `activeId` down instead of `useParams()` per row, same for ConversationPicker; `useDeferredValue` on both search inputs; virtualise past ~200 rows. `[B4]` |
| PB-5 | Trace tree is O(n²) (TracePage filters all spans per node; min/max recomputed per render). AgentsPage already solves this with a Map in `useMemo` — copy it. `[B5]` |
| PB-6 | Strip task-ID archaeology from comments (files are 13–24% comments, mostly P1-T13 / not-built-here / T08's-job). Keep every WHY comment. **Run this last** — it touches every file. `[B6]` |
| PB-7 | Split `src/test/msw/handlers.ts` (~2.5k lines, imported by 45 test files) — needs a shared state module + counters object first. `[B8]` |
| PB-8 | Consider enabling the React Compiler — first fix the three render-phase ref writes (`App.tsx:35`, `App.tsx:112`, `QueueContext.tsx:83`) its lint rules reject. `[B9]` |
| PW-1 | Whitelabel-lite — `npm run init` asks name / trees-label / backend URL and writes `agentic.config.ts`; wire `product.label` through every UI string so an adopter's name renders. |

---

## Stage A+ — A/B compare

Plan: `docs/plan-ab-compare.md`. Most machinery exists (turn re-fire already fans one turn
to N endpoints under one `run_id`); what is missing is doing it live in chat and across
backends. Sequenced after PB-1 deliberately.

| id | item |
|---|---|
| PAB-1 | Chat compare mode within one backend — `tune`-gated toggle picking 2–3 variants (endpoint / instruction version / model), server-side fan-out on send, N-column transcript each streaming its own reply, and the result IS a run so the existing grid + judge + summary work unchanged. Warn about N generations = N bills before sending; cap columns at 3. **deps: PB-1** |
| PAB-2 | Studio: vary the deploy target in a run — widen `endpoint_ids` beyond turn re-fire, then flip RunConfigPanel's existing `showEndpoints` flag on for the Runs stepper. The contract half is an additive clarification that **must fold into P3-T00, not be smuggled in separately**. **deps: P3-T00** |
| PAB-3 | `compareSets` presets in `agentic.config.ts` + picker UI, so a team's usual A/B is one click. **deps: PAB-1** |
| PAB-4 | Cross-backend compare — per-request target override in `src/api/client.ts`, N unrelated conversations in N databases. No shared `run_id` means the grid and judging do not apply for free. Overlaps P4-HYBRID (same client refactor). **Deferred; blocked on decision Q1.** |

---

## Stage B — UX polish phase

Desktop-first. **Planned with the user before any task runs.** Organising principle: the
wedge persona's first ten minutes, ending with THEIR agent answering in a real UI — not
our demo with fake data. Known inputs to that planning session:

- README / first-run must lead with "bring your own agent"; `cupel-ready --init` is the on-ramp.
- **No tree switcher exists** — the app has one active tree from config, so cross-tree
  results (e.g. a casebook replay spanning trees) cannot be linked.
- Coverage gaps from P2-RECORD: no visual-regression/snapshot testing at all; e2e films
  run against the Vite dev server, never the built bundle Render serves; chromium only;
  portrait filmed nowhere; BYOK live mode, `CUPEL_STORAGE=s3` restore, a11y/keyboard paths
  and SSE-drop/5xx surfaces all untested.

Phase 3 begins only after Stage B closes and the user says so.

---

## Phase 3

| id | item |
|---|---|
| P3-T00 | Contract v0.4.0 — all 15 review-bucket-C items (C1–C15 below) plus two later gaps. **Runs first in Phase 3**: the CLIs generate from the contract, so bump it before they ship. |
| P3-DOCS | Persistence guidance — review bucket D (D1–D3 below). Pairs with the backend scaffolder, which must point at it. |
| P3-CTX | Context policy widening — frozen/today/custom + fallback for envelope-less turns + recorded-tools playback. Plan: `docs/plan-context-policy.md`. **Contract already shipped in v0.3.0 — implementation only**, 6 steps, all unstarted. Key risk: frozen must stay the default when the field is omitted; assert in all three test layers. |
| P3-GEN | Generator control API + Settings drip-rate controls (un-greys the placeholders at `SettingsPage.tsx:253,258,264`). |
| P3-MEM | Memory panel — view/edit/clear per tree, compaction as a visible queued task. |
| P3-K8S | k8s manifests + Helm post-upgrade Playwright job gating the release (artifacts + local validation, no live cluster). |
| P3-CLI2 | `cupel-cli` — terminal client to any conformant backend. Plan: `docs/plan-cupel-cli.md`, 4 sub-tasks A–D. **3 open questions first.** |
| P3-CLI | `agentic-app-maker` — project scaffolder. Plan: `docs/plan-agentic-app-maker.md`, 5 sub-tasks A–E. **5 open questions must be answered before building.** |

### Review bucket C — the contents of P3-T00

Tracked as one task above; listed here so nobody re-reads the review doc.

C1 uniform cursor-paginated `Page<T>` collections · C2 conversations without inlined turns ·
C3 run-grid pagination + ETag · C4 `POST …/versions` replacing non-idempotent PUTs (mock
still `PUT /eval/rubrics/{id}`:1454, `/eval/cases/{id}`:1669, `/eval/sets/{id}`:1731, all 201) ·
C5 readable version history (GET + `?version=` + `…/versions`; also `GET /eval/cases`) — this
is why the workbench cannot show history today · C6 `Idempotency-Key` on 202s — **also the
only way to close the two-tab double-judge residual** · C7 SSE event ids + `Last-Event-ID` ·
C8 per-operation permission semantics + 403s · C9 `Error.details[]` / `request_id` + 422/429/503 ·
C10 batch turn fetch · C11 `Health.contract_version` + capabilities · C12 visible soft-delete ·
C13 search semantics · C14 span retention · C15 close the mock's implementation gap.

Plus two gaps found after the review: (i) the mock correctly returns 409 `tree_disabled` from
six ops whose contract entries declare only 2xx/404 (POST agents, PUT instructions, POST
snapshots, PUT last-selection, PATCH + DELETE conversation) — the contract under-declares;
(ii) 422 is undeclared everywhere except `/eval/cases/import` while both implementations
return it freely.

**Partially done, do not assume open:** A2's per-event tree resolution and per-subscriber
permission filter landed (`mock/engine.py:68-92,128-180`); only the `tree`/`run_id`/`task_id`
subscription params remain, and they live in C8/C1. C15 is partial — casebooks and eval
sets/cases/import are implemented; memory, settings and generator endpoints are not, and
those belong to P3-MEM / P3-CTX step 0 / P3-GEN respectively.

### Review bucket D — the contents of P3-DOCS

D1 write `docs/persistence.md` (Postgres spine w/ partitioning + indexes, object storage for
span payloads and attachments, ClickHouse/OTLP for span metadata, durable workflow engine for
the task queue, Redis for SSE fan-out + idempotency) · D2 add the "good shape, do NOT copy the
physical layer" header to `mock/db.py` · D3 add a tenant/owner column to the reference schema.

**D3 is partial**: `conversations.user_id` exists with a migration (`mock/db.py:45-52,223-239`)
but it was added by P2-T12a for the Inspector, not as the schema-wide ownership column.

---

## Phase 4 — the rest of the roadmap (free, like everything else)

| id | item |
|---|---|
| P4-REPO | Agents as Code — GitHub connect, instruction changes as PR diffs, merge promotes the version live; mock git server. No free tool does this; headline differentiator. |
| P4-SHARE | Public sharing — anonymous tokenised share links for conversations/turns, with expiry and revocation. Growth mechanism; extends P2-SHARE's in-app deep links. |
| P4-AGUI | AG-UI bridge — **decision required before building** (Q3 below). Spike done: `docs/spike-agui.md`, commit `ee9538f`, recommends adopt-partially via `mock/agui.py` on the existing `adapter?:` seam (`agentic.config.ts:60`), ~400–600 LOC. Not a client transport, not a contract change. **deps: P3-T00** |
| P4-HYBRID | Hybrid backend fill — per-feature-family routing, table derived from the `cupel-ready` gap report, visible "served by mock" badges, demo-quality only. **May be made redundant by P3-CLI's `--gap-as-mock`; see Q4.** |

Parked indefinitely: a hosted multi-tenant platform. Not on any roadmap. (`cupel-phases.md`
still claims it as Phase 4 — see D-3.)

---

## Decisions blocking work — 11 open questions

Several tasks above say "do not start until answered". Nothing here is a code problem.

| # | task | question |
|---|---|---|
| Q1 | PAB-4 | Who judges a cross-backend compare, and how is that labelled? Options posed: nominate one backend as scorer (legitimate but the judging text is produced elsewhere and must be labelled) vs. judge client-side. |
| Q2 | P3-CTX | `tools_mode: replay_recorded` on a turn whose trace has no tool spans — silent no-op or cell error? Must be decided and documented. |
| Q3 | P4-AGUI | Also ship a thin client-side adapter behind a loud "chat-only, nothing is persisted" banner, purely as a 60-second demo? Spike's own answer: doubles maintenance, would not do it in the first pass, but it is the honest counter-proposal. Re-read the spike's five "what would change my mind" watch items before deciding — AG-UI persistence (#2159/#2186/#1160), resumability (#2105/#2106), token usage *with spend* (#2188), foundation donation + 1.0, and whether framework builders will run a second process. |
| Q4 | P3-CLI | Does `--gap-as-mock` make P4-HYBRID redundant? Recommendation: yes — static family-level gap filling in Phase 3, delete P4-HYBRID. |
| Q5 | P3-CLI | What language is `create-backend`? Recommendation: FastAPI/Python first, TypeScript/Express later. |
| Q6 | P3-CLI | Feature trimming (`--features no-evaluate`) — in or out? Recommendation: out. |
| Q7 | P3-CLI | Does `--same-repo` rename the git remote / reinitialise history? Recommendation: no, touch no git state, print a suggestion. |
| Q8 | P3-CLI | Should the generated backend include a working reference implementation of the simple families (chat, conversations) rather than only stubs? Recommendation: yes for chat + conversations, stubs elsewhere. |
| Q9 | P3-CLI2 | Config file for defaults (`~/.cupel/config.json`)? Convenient but a second source of truth alongside `agentic.config.ts`. Recommendation: credentials only in `~/.cupel/`. |
| Q10 | P3-CLI2 | Ship on npm as `npx cupel-cli`, or checkout-only? Recommendation: checkout-only first. |
| Q11 | P3-CLI2 | `fav` / aliases (the original `loom fav refunds`)? Recommendation: defer — needs Q9's config file. |

---

## Doc + code debt — not tracked in TASKS.md

Found by the 2026-08-08 sweep. None of it is in any task above.

| id | item |
|---|---|
| D-1 | `react-migration.md` is dead weight — a Streamlit→React migration guide requiring an `INVENTORY.md` that does not exist, for a codebase with no Streamlit in it. **`CLAUDE.md:3` still names it as the mandatory first read**, so it actively misleads every new session. Delete it and fix CLAUDE.md, or replace it with the evidence rules it was cited for. |
| D-2 | `docs/deployment.md:88,111-115,139-146` describes the R2 bucket and the s3 boot/restore/`/healthz` behaviour as if configured and observed. None of it has ever run (see PH-3). Mark it as untested until PH-3 lands. |
| D-3 | `cupel-phases.md` is stale in five places: `helm install cupel ./chart` (`:112`, no `chart/` exists); a PR round-trip in the Phase-2 DoD (`:119`, cancelled); `npm run dev` as the front door (`:10,:51-56`, it is `npm start`); `npx cupel-ready` / `npx create-agentic-app` / `cupel chat` (`:74,:109,:127,:134`, package is `private: true` and unpublished); and Phase 4 = hosted multi-tenant platform (`:142-155`), directly contradicted by `docs/features.md:86` "Not planned". |
| D-4 | `docs/index.html:296` claims **19** end-to-end journeys. There are 13 (19 is the `test()` block count; README and CLAUDE.md both say 13). |
| D-5 | `docs/index.html:271-276` shows `npx cupel-ready …` as installable. Package is `private: true` and unpublished — only `npm run ready` and the local bin work. Same class of error as D-3. |
| D-6 | Stale paid-tier language survives in code and plans: `src/lib/shareLink.ts:8` and `src/pages/ChatPage.test.tsx:985` say "PRO-2"; `TASKS.md:43,58,59` say "pro tier" / "excluded from free build" / "PRO-3 Reels"; `docs/plan-agentic-app-maker.md:28,171`. All contradict the no-paid-tier decision. (`docs/deployment.md`'s "free tier" is Render's hosting plan — correct, leave it.) |
| D-7 | `feature-spec.md` has two wrong routes: `:32,:282` say `/agent-trees`, contract says `/agenttrees`; `:127,:151` say unscoped `/turns/{id}/trace`, actual route is tree-scoped `/agenttrees/{tree}/turns/{id}/trace`. |
| D-8 | `README.md:116` cites "13 journeys (`feature-spec.md:205-218`)" but that checklist is numbered 1–12; journey 13 lives at `feature-spec.md:99`, outside the cited range. |
| D-9 | **No lint setup at all.** Five `eslint-disable-next-line react-hooks/exhaustive-deps` comments exist (`RunConfigPanel.tsx:128`, `CasebooksPage.tsx:262`, `EditorPage.tsx:139`, `RunsPage.tsx:200,:221`) but there is no eslint config at the repo root, so they are inert and nothing enforces the rule they suppress. Resolve alongside PB-8, which depends on those same rules. |
| D-10 | `mock/db.py` has no indexes and only the ADK-shape note. Folded into D2 above but worth doing whenever `mock/db.py` is next touched. |

### Known-good, do not "fix"

- The three `test.skip` calls in `e2e/j10-permissions`, `j11-tree-disable`, `j12-auth` are
  `AUTH_E2E` gates that run under `npm run e2e:auth`. Not abandoned tests.
- `SettingsPage.tsx:253,258,264` disabled controls are deliberate placeholders pinned by a
  test at `SettingsPage.test.tsx:173`. Un-greying them is P3-GEN and requires editing that test.
- `scripts/cupel-ready.mjs:203` emits a literal `"TODO: …"` string into generated config.
  That is intended output for the adopter, not our TODO.
- `src/test/msw/parity.test.ts:655-665` is a deliberate registry of unimplemented operations
  (P3-MEM memory ops, P3-GEN generator ops, GET/PUT `/settings`).
