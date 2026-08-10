# Open items — evidence and detail

> **Ids changed 2026-08-09.** `TASKS.md` is now a flat numbered list — `#1`, `#2`, … — and the
> old prefixes (`PH-`, `PB-`, `PW-`, `PAB-`, `P3-`, `P4-`, `C`, `D`) are retired. **`TASKS.md`
> is the queue; this file is the evidence behind it.** Old ids below survive as the trail back
> to commit messages. Mapping of everything still open:
>
> | old | new | | old | new | | old | new |
> |---|---|---|---|---|---|---|---|
> | R-1…R-5 | #1–#5 | | PB-2 leftovers | #7, #8 | | P3-T00 | **#14** |
> | PB-3 residual | #9 | | PB-8 residual + D-9 | #10 | | P3-DOCS + D-10 | #15 |
> | PW-1 follow-up | #11 | | P3-CTX | #16 | | P3-GEN | #17 |
> | P3-MEM | #18 | | P3-K8S | #19 | | P3-CLI2 | #20 |
> | P3-CLI | #21 | | P4-REPO | #22 | | P4-SHARE | #23 |
> | P4-AGUI | #24 | | P4-HYBRID | #25 | | PAB-2 | #26 |
> | PAB-4 | #27 | | PH-5 | #28 | | PH-2 | #29 |
> | PH-3 | #30 | | D-1 | #31 | | D-3 | #32 |
> | D-6 | #33 | | D-7 | #34 | | D-5 | #35 |
> | D-2 | #36 | | D-12 | #37 | | D-11 | #38 |
>
> `D-4` and `D-8` folded into #5. Bucket C's `C1`–`C15` are no longer ids — they are the
> checklist inside #14(a). `Q1`–`Q11` are unchanged. Closed: `PH-1`, `PH-4`, `PB-1`…`PB-8`,
> `PW-1`, `PAB-1`, `PAB-3`, and all of Phase 1 and Phase 2.

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
| PH-4 | **Done 2026-08-09**: shim deleted — `mock/__init__.py` is now a one-line docstring module. Nothing depended on it (no caller, no test; `render.yaml` was already all `CUPEL_*`; no `.env*` in the repo). Verified: `import mock` OK, `npm run test:mock` 160 passed. Remaining `SKEIN_` hits are doc prose only. | done |
| PH-5 | Decide repo visibility. Both repos private; going public is the point of the stars/community strategy, but README + site should be launch-ready first. | deferred, user decision |

---

## Stage A — code quality + make-it-yours

**CLOSED 2026-08-08.** All nine tasks done; review bucket B is fully discharged. Residuals
are listed per-task below and are small. Suite went 542 → 617 tests as several tasks added
coverage for behaviour that had never been tested.

The `[Bn]` tags are the corresponding review-bucket-B item — **same item, not a duplicate.**

| id | item |
|---|---|
| PB-1 | **Done 2026-08-08** (`dc3bef7`): 1390 → 522 lines + seven files under `src/pages/chat/`; test file byte-identical. **Residual:** ByokSection owns its own state and ChatSettingsMenu knows nothing about it, but it is still *rendered* inside the settings popover. Moving it visually (e.g. into the Settings page's Backend section) is a UX change needing a new affordance to open it, so it belongs to Stage B, not here. `[B1]` |
| PB-2 | **Mostly done 2026-08-08** (`77f7ad2`): `src/hooks/useAsync.ts`, 13 of 20 candidate sites converted, ~158 lines removed at call sites. **7 sites deliberately skipped** — see the list below; only two are quick wins. `[B2, B7]` |
| PB-3 | **Mostly done 2026-08-08** (`271cad7`): one `useReducer`, both `eslint-disable` exhaustive-deps removed by making deps genuinely complete. **The remount-by-key stays** — `RunConfigPanel` treats `initialFocus` and `judgeInitiallyOpen` as mount-time-only state (`:119`, `:125-129`), so a preset arriving mid-Configure would not re-focus or reset the judge section without it; verified load-bearing by switching to `key={i}`, which fails. Residual fix: make those two props controlled in `RunConfigPanel`, then the key drops to `i`. `[B3]` |
| PB-4 | **Mostly done 2026-08-08** (`57bfd95`): rows memoised, `activeId` threaded, `useDeferredValue` on both searches. **Virtualisation deliberately skipped** — rows are variable height, the sidebar does not own its scroll container, and `page_size` caps at 100 (`openapi.yaml:681-683`) behind an explicit "Load more", so row count is user-bounded; same call `InspectorPage.tsx:57-60` already documents. If it is ever wanted, the dependency-free route is `content-visibility: auto` + `contain-intrinsic-size` per row, which keeps nodes in the DOM so tests and Ctrl-F still work. `[B4]` |
| PB-5 | **Done 2026-08-08** (`b682195`) — this row was never backfilled, the task itself was complete. Both halves fixed in `TracePage.tsx`: child grouping is a `{roots, childrenOf}` Map in `useMemo` (`:159-173`, consumed O(1) at `:189`), and the timeline domain is one memoised pass (`:143-154`), which also killed a `Math.min(...spread)` that could blow the stack on a large live trace. A literal transliteration of `AgentsPage.tsx:46-61`, as the task asked. **Residual:** coverage is behavioural only (`TracePage.test.tsx:53,:76` pin the output, so a regression to the O(n²) form would still pass); and `TracePage.tsx:186` still does `spans.find(...)` per render — O(n) once per render, not the O(n²) this task was about. `[B5]` |
| PB-6 | **Done 2026-08-08** (`d5f0dd7`): task-ID refs 441 → 43 across 137 files (37 of the 43 survivors are test titles/string literals, i.e. code). Fixed **23 stale "not built" comments** that were outright false — the queue panel, instruction editor, turn re-fire, fork pivot, judge layer and trace view all shipped. **Finding contra B6's premise:** comment ratio only moved 13.42% → 13.38%. The volume is spec citations and WHY notes, not archaeology; the archaeology was inline ID tags inside otherwise-valuable prose. Reducing comment *volume* would be a different and riskier task. `[B6]` |
| PB-7 | **Done 2026-08-08** (`704188e`): 2557 lines → an 85-line barrel + `state.ts` + 11 `routes/*.ts`. Zero importing files changed (26 of them, not the 45 TASKS.md estimated). The 14 `let` counters became one object because an imported `let` cannot be reassigned across a module boundary — each module would otherwise have got its own silent copy. `[B8]` |
| PB-8 | **Done 2026-08-08** (`38840fc`): all three render-phase ref writes gone (React 19.2's stable `useEffectEvent` in App.tsx; an effect in QueueContext, since effect events must not cross component boundaries). **Recommendation: adopt the lint half, decline the compiler.** `eslint-plugin-react-hooks@7` (`recommended-latest`) carries the `react-hooks/refs` rule that catches this class, costs 3 dev deps and never touches the bundle. Do NOT enable the compiler: this is a Vite 8 / rolldown pipeline with **no Babel at all**, so it means 4 new deps to reintroduce a per-file Babel pass, plus a mandatory mirror into `vitest.config.ts` or you ship compiled code while testing uncompiled. Note `eslint-plugin-react-compiler` is dead at `19.1.0-rc.2`; the rules moved into `eslint-plugin-react-hooks` v6+. `react-compiler-healthcheck` is a free manual gate but proves compilability, not correctness — it reported 59/59 *while all three ref writes were still present*. **Residual:** one more render-phase ref write at `InspectorPage.tsx:192`. `[B9]` |
| PW-1 | **Done 2026-08-08** (`bdb63c9`): `npm run init` (edits the config in place, so hand-written docs, extra targets and `compareSets` survive; `.bak` + temp-and-rename; reuses `cupel-ready`'s detection rather than a second implementation). 12 hardcoded sites threaded through `src/lib/product.ts`, guarded by a new `tests/no-hardcoded-product-name.test.js`. One string could not be parameterised — EvalPage's "an agent tree" breaks on a vowel-initial term, rewritten to "a single {one}"; it is the only place the default English changed. **Follow-up:** `docs/features.md:65` still marks this planned (🗓️). |

---

### PB-2 leftovers — the 7 unconverted fetch sites

Quick wins, blocked only by concurrency at the time:
- `src/pages/chat/ByokSection.tsx:67` and `src/pages/chat/CompareView.tsx:132` — both clean converts.

Genuinely need work first, do not just force the hook in:
- `EditorPage.tsx:99-128` — the response is torn into six form buffers *and* locally mutated by
  `save()`. Any seed-on-data effect re-fires after a save and can clobber a draft the user is
  still typing (the Textarea is not disabled while saving). Needs the editor body extracted into
  a keyed child, PB-1-shaped, first. **This is a latent data-loss bug independent of PB-2.**
- `SettingsAdmin.tsx:53` (MembersSection) and `EvalPage.tsx:106` — one fetch feeds two
  independently-mutated states; conversion adds lines rather than removing them.
- `EvalPage.tsx:129`, `CasebooksPage.tsx:237` — incremental cache-fill loops, not a
  data/loading/error read.
- `SettingsPage.tsx:87` — the model the union shape came from, but its `fail` branch carries
  `latencyMs`, which the generic error state cannot hold. Left alone deliberately.

Also unconverted by design: `ChatPage.tsx:184` (turns are stream-mutated), `ChatPage.tsx:229`
(no loading state), `RunsPage.tsx:271` (dispatches into PB-3's reducer).

## Stage A+ — A/B compare

Plan: `docs/plan-ab-compare.md`. Most machinery exists (turn re-fire already fans one turn
to N endpoints under one `run_id`); what is missing is doing it live in chat and across
backends. Sequenced after PB-1 deliberately.

| id | item |
|---|---|
| PAB-1 | **Partly done 2026-08-08** (`d884eb5`): `tune`-gated toggle, fan-out on send, N-column transcript, result is a real run, cost warning, 3-column cap. **Only the endpoint axis varies.** `ReplayTurnRequest` carries `endpoints[]` but a *single* shared `config`, so per-column instruction version / model is not expressible under contract v0.3.0. Remaining work is the contract change below, then widening the picker. |
| PAB-2 | Studio: vary the deploy target in a run — widen `endpoint_ids` beyond turn re-fire, then flip RunConfigPanel's existing `showEndpoints` flag on for the Runs stepper. The contract half is an additive clarification that **must fold into P3-T00, not be smuggled in separately**. **deps: P3-T00** |
| PAB-3 | **Done 2026-08-08** (`b9c8d70`): `compareSets: {id, label, trees?, variants}` + picker. Key is `variants` not `endpoints`, so `configs[]` needs no breaking config rename later. A set carrying per-column `config` is **refused with a reason, not run** — warn-and-run would let a preset labelled "current vs previous version" silently compare prod vs staging. Validator flips reject→apply when `configs[]` lands. **Open question:** the plan's `endpoints: ["staging","prod"]` was read as deploy-endpoint *names*; PAB-4 will want *target* ids in the same structure and needs a distinct key (`target`). Also `versions: "last-2"` needs relative-version expansion, which the contract fix does not provide. |
| PAB-4 | Cross-backend compare — per-request target override in `src/api/client.ts`, N unrelated conversations in N databases. No shared `run_id` means the grid and judging do not apply for free. Overlaps P4-HYBRID (same client refactor). **Deferred; blocked on decision Q1.** |

---

## Stage R — domain tighten: kill the "Runs" concept

**User decision 2026-08-09.** Runs / Eval / Casebooks are three peer menu entries for one
loop; Tune and Evaluate are the same page differing by which field gets focus and whether the
judge panel starts open (`RunsPage.tsx:439-442`); and `POST /eval/judge` with a `run_id`
auto-creates eval cases from the run's turns (`openapi.yaml:1556`) — a run *is* an evaluation.
Target: two doors, **Chat** and **Evaluate**.

**No backward compatibility** (same decision): unlaunched, both repos private, package
`private: true` and unpublished, zero adopters. No shims, no aliases, no deprecation window.
**That window closes at PH-5** — so Tranche 2 lands before PH-5 and before P3-CLI/P3-CLI2.

**Revisit after both tranches**, before planning Stage B.

| id | item |
|---|---|
| R-1 | Two doors — merge the three sidebar peers into one Evaluate section; **delete** the Tune/Evaluate presets and their reducer branches. Obsoletes `feature-spec.md:101-103,:294` rather than renaming them. |
| R-2 | Routes `/runs` → `/evaluations` (+ detail), **with redirects** — P2-SHARE deep links and `CompareView.tsx:416` build shareable run URLs. |
| R-3 | Copy + component renames, incl. "Test in Runs ▸". Careful: `docs/features.md:55` "Runs with no backend" is the verb. |
| R-4 | E2E — ~84 sites across 10 files; `j03-runs` → `j03-evaluations`; only 2 endpoint tags change in Tranche 1. |
| R-5 | Docs for Tranche 1 — `feature-spec.md` is the heaviest hit (40+ lines); fix D-4 in the same pass. |

Tranche 2 (the wire rename, the Casebook/EvalSet merge, `Judgment.subject`/`scorer`, derived
`Evaluation.status`) is **folded into P3-T00** — see `TASKS.md`. It is not a separate task and
must not be a separate contract bump.

Derived `Evaluation.status` **landed 2026-08-09** (item 7 stage D). Two findings worth keeping:
(a) **nothing was duplicated in the store** — `evaluations` never had a `status` column in any
revision of `mock/db.py`, so the drift was never storage, it was two *aggregates*: `run_batch`
finished a partly-failed batch as `done` while `retry_failed` finished the same batch as
`failed`. Only one survives — a batch parent is `done` when its pass completes, and per-unit
failure surfaces on the children and on the derived evaluation. (b) The partial-failure read
is deliberately `failed`, not `done`: `Task.status` answers "did the batch finish", which the
queue journey pins as `done`, and `Evaluation.status` answers "is the grid complete", which it
is not. A task that no longer exists falls back to the cells, which outlive it.

`Judgment.subject`/`scorer` **landed 2026-08-09** (item 7 stage C). Three decisions recorded
so they are not re-litigated: (a) **`evaluation_id` stays a top-level scope field**, not a
subject — an LLM judgment of a grid cell judges the CASE, and folding the evaluation into
`subject` would make one case scored inside two evaluations collide, breaking
`?evaluation_id=`, the score summary and `Result.latest_score` at once; (b) the enums are
declared **tight** — `subject.kind` is `case|turn` and `scorer.kind` is `llm|human`, because
nothing produces `result`, `evaluation` or `check` today and an undeclared value is dead
contract surface `cupel-ready` would report as a gap; adding one later is an enum value, not
a reshape; (c) `conversation_id` survives as a **query filter and a physical index only** —
it is no longer a `Judgment` field, because the chat view needs one request per conversation
but never reads the value back. **Still open** (inherited from stage B, unchanged by the
reshape): a judgment made against an eval-set version names a case that may not be a member
of that version, because judging resolves reference items into cases without rewriting
membership. The reshape neither fixes nor worsens it — but it does give the fix an obvious
home, a `set_id`/`set_version` scope pair beside `evaluation_id`. Needs eval-set design, not
judgment design.

**Blast radius, measured 2026-08-09:** `run_id` — 151 in `openapi.yaml` + `mock/`, 142 in
`src/`, 28 in `e2e/`; 48 files total. But only ~5 user-visible strings and 2 routes. That
asymmetry is why the concept is nearly free to kill today and the identifier is not.

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

**C1 uniform paginated `Page<T>` collections — DONE 2026-08-10** (item 7 stage F1). Landed as
OFFSET paging, not the cursors the review asked for: every consuming surface offers "load
more" or a page jump, and both need the `total` a cursor page does not carry — the Inspector's
page counter and the new "showing N of M" footers are that total. `LIMIT`/`OFFSET` is also
portable to whatever store an adopter implements the contract over, where a keyset cursor is
per-database work with an encoding each implementor would have to invent. The shape is
`{items, page, page_size, total}`, one `<Thing>Page` schema per item type, enforced by three
tests in `tests/openapi-contract.test.js`. Four bare-array responses stay, each documented at
its own response: `GET /models`, `GET /agenttrees/{tree}/endpoints` (backend-configured
enumerations a dropdown needs whole), `GET /agenttrees` (the scope selector every path hangs
off) and `GET /agenttrees/{tree}/agents` (a hierarchy — a page of it orphans nodes). The last
two are the honest gap: paging them needs a searchable tree picker and a lazy-expand
traversal respectively, both real UX, both item 17. `GET /tasks` lost `limit` in the process.

**C2 conversations without inlined turns — DONE 2026-08-10** (item 7 stage F2). `Conversation`
loses `turns` and gains `turn_count`; the transcript is
`GET /agenttrees/{tree}/conversations/{id}/turns` (`TurnPage`), the contract's 67th operation
and the `conversations` family's 5th. Two things there differ from every other listing, both
deliberate: rows are CHRONOLOGICAL, which makes offset paging stable (a transcript grows only
at the tail, so page 1 is immutable while a reader is on it), and an omitted `page` means the
LAST page, because that is where a reader of a transcript starts — one round trip to the part
they came for. `?turn_ids=` fetches named turns without walking pages; it keeps the eval-set
reference preview honest now that whole conversations are no longer pulled to read one turn
out of each, and it is a partial answer to C10, which still lacks CROSS-conversation
batching. UI: ChatPage gained "Load earlier turns" (a prepend — pages are contiguous, so no
de-duplication); the Inspector reader and both turn pickers fetch on demand and state when
they are showing a prefix.

C3 run-grid pagination + ETag · C4 `POST …/versions` replacing non-idempotent PUTs (mock
still `PUT /eval/rubrics/{id}`:1454, `/eval/cases/{id}`:1669, `/eval/sets/{id}`:1731, all 201) ·
C5 readable version history (GET + `?version=` + `…/versions`; also `GET /eval/cases`) — this
is why the workbench cannot show history today · C6 `Idempotency-Key` on 202s — **also the
only way to close the two-tab double-judge residual** · C7 SSE event ids + `Last-Event-ID` ·
C8 per-operation permission semantics + 403s · C9 `Error.details[]` / `request_id` + 422/429/503 ·
C10 batch turn fetch · **C11 `Health.contract_version` + capabilities — DONE 2026-08-09**
(item 7 stage E; delivered early because it is additive and it is where the declared families
land) · C12 visible soft-delete ·
C13 search semantics · C14 span retention · C15 close the mock's implementation gap.

**Also fold in (found by PAB-1, 2026-08-08):** `ReplayTurnRequest.configs[]` — a `RunConfig`
per entry in `endpoints[]`, or a combined `variants[]` of `{endpoint_id, config}` — so one
turn re-fire can vary endpoint, instruction version and model per column under a single
`run_id`. Today it carries `endpoints[]` with one shared `config`, which caps chat compare
at the endpoint axis alone. Same family as the `endpoint_ids` widening PAB-2 needs; do both
in one edit.

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
| D-7 | `feature-spec.md` has two wrong routes: `:32,:278` say `/agent-trees`, contract says `/agenttrees`; `:147,:290` say unscoped `/turns/{id}/trace`, actual route is tree-scoped `/agenttrees/{tree}/turns/{id}/trace`. (`:123` was cited here in error — it already shows the tree-scoped route.) |
| D-8 | `README.md:116` cites "13 journeys (`feature-spec.md:205-218`)" but that checklist is numbered 1–12; journey 13 lives at `feature-spec.md:99`, outside the cited range. |
| D-9 | **No lint setup at all.** Five `eslint-disable-next-line react-hooks/exhaustive-deps` comments exist (`RunConfigPanel.tsx:128`, `CasebooksPage.tsx:262`, `EditorPage.tsx:139`, `RunsPage.tsx:200,:221`) but there is no eslint config at the repo root, so they are inert and nothing enforces the rule they suppress. Resolve alongside PB-8, which depends on those same rules. |
| D-10 | `mock/db.py` has no indexes and only the ADK-shape note. Folded into D2 above but worth doing whenever `mock/db.py` is next touched. |
| D-12 | **Partly addressed 2026-08-09** (item 7 stage E): the count is now 66, not 69, and the three prose sites plus `docs/index.html`'s fact tile were corrected by hand — the *derivation* is still owed, so this stays open. What DID get a source of truth is the family list: `openapi.yaml`'s top-level `tags`, consumed by `scripts/conformance.mjs` (`families()`, `familyReport()`) and reported by `cupel-ready`, with four contract tests making the tag-per-operation partition an invariant. **The "69 operations" count is copy-pasted into three docs with no source of truth** (found by the 2026-08-09 sweep): `docs/spike-agui.md:495` is the authoritative breakdown ("chat 3, runs 4, trace 2, tasks 5, eval 13, casebooks 9, settings 2 = 69"), and `docs/readiness.md:108` ("5/69 → 37/69") and `docs/index.html:273` ("44/69") both restate it. Any contract change moves all three, and nothing enforces it. Same family: `scripts/conformance.mjs:47,48,59` and `tests/openapi-contract.test.js` hold parallel path lists that `docs/readiness.md:44-46` documents as needing to move together. Cheapest fix: derive the count from `openapi.yaml` in the readiness script and stop hardcoding it in prose. |
| D-11 | The suite is not clean under **full** shuffle (files *and* tests within files). Two failures, both pre-existing and both reproducing with their own unmodified file in isolation, so neither came from the PB-7 split: (i) `parity.test.ts` registers a `response:mocked` listener in `beforeAll` that stays attached for the whole file and attributes every later request to whatever `currentApiMethod` last held, so disabled-tree tests pollute the last exercise's exchange list; (ii) `ChatPage.test.tsx > renders tokens incrementally`. File-order shuffle alone is green — vitest isolates each file's module registry, so handler state cannot leak between files. Worth fixing only if you want the suite shuffle-clean. |

### Known-good, do not "fix"

- The three `test.skip` calls in `e2e/j10-permissions`, `j11-tree-disable`, `j12-auth` are
  `AUTH_E2E` gates that run under `npm run e2e:auth`. Not abandoned tests.
- `SettingsPage.tsx:253,258,264` disabled controls are deliberate placeholders pinned by a
  test at `SettingsPage.test.tsx:173`. Un-greying them is P3-GEN and requires editing that test.
- `scripts/cupel-ready.mjs:203` emits a literal `"TODO: …"` string into generated config.
  That is intended output for the adopter, not our TODO.
- `src/test/msw/parity.test.ts:655-665` is a deliberate registry of unimplemented operations
  (P3-MEM memory ops, P3-GEN generator ops, GET/PUT `/settings`).
