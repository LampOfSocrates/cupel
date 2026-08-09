# Cupel — the todo list

**One id scheme: a number.** `#1`, `#2`, … assigned once, never reused, never renumbered.
No phase/stage/bucket prefixes. Group headings say *when*; they are not part of the id.

- Runner picks the first unchecked box in **Now**, top to bottom.
- Protocol per task: implement → tests green → commit `#<id>: <summary>` → stop.
- Detail and evidence for most items: `docs/open-items.md`. This file is the queue.
- Open questions are `Q1`–`Q11` (see bottom). They are not tasks; they block tasks.
- Completed work (Phase 1, Phase 2, Stage A) is in git and summarised in
  `docs/open-items.md` "Closed — do not re-investigate". Old ids (`P2-T17`, `PB-4`, …)
  survive in commit messages only.

Invariants (never break): versions/judgments/snapshots append-only · generator writes only
via public API · /me always called · no AUTH_MODE branches · one config artifact.

---

## Now — kill the "Runs" concept (UI only, no contract change)

Why: Runs / Eval / Casebooks are three peer menu entries for one loop; Tune and Evaluate are
the same page differing by which field gets focus and whether the judge panel starts open
(`RunsPage.tsx:439-442`); and `POST /eval/judge` with a `run_id` auto-creates eval cases from
the run's turns (`openapi.yaml:1556`) — a run *is* an evaluation. Target: two doors, **Chat**
and **Evaluate**. User decision 2026-08-09.

- [ ] **#1** Two doors — merge the sidebar's three peers (`Sidebar.tsx:23-28`) into one
      Evaluate section. **Delete** the Tune/Evaluate presets (`:36-39,:98-106`) and everything
      downstream: RunsPage's preset reducer branches (`:140-159,:172,:203,:220,:399-401,
      :439-442`), `Sidebar.test.tsx:112-120`, `RunsPage.test.tsx:299,:314,:333,:336`.
      Obsoletes `feature-spec.md:101-103,:294` — they are deleted, not renamed.
- [ ] **#2** Routes — `/runs` → `/evaluations`, `/runs/:runId` → `/evaluations/:id`
      (`App.tsx:196-198`) **with redirects**: share deep links are in the wild and
      `CompareView.tsx:416` mints run URLs. Update route pins: `returnTo.test.ts:35` (add a
      redirect case), `App.test.tsx:152`, `QueuePage.test.tsx:37,:104`, `ForkModal.test.tsx:64`,
      `CompareView.test.tsx:23`, `EditorPage.test.tsx:209`.  [after #1]
- [ ] **#3** Copy + component names — `RunsPage`→`EvaluationsPage`,
      `RunDetailPage`→`EvaluationPage`; "Runs"→"Evaluations" (`RunsPage.tsx:323`), "New run"→
      "New evaluation" (`:325`), "Test in Runs ▸"→"Test as evaluation", the compareSets
      rejection string (`compareSets.test.ts:75`), `agentic.config.ts:131,:164`.
      **`docs/features.md:55` "Runs with no backend" is the verb — do not replace it.**  [after #2]
- [ ] **#4** E2E — ~84 sites across 10 files. Rename `j03-runs.spec.ts`→`j03-evaluations.spec.ts`;
      update j05 (13), j07 (10), dod (9), smoke (5), j01 (5 — the preset assertions at
      `:51,:56` die with #1), j12 (`:59`), j13 (27, mostly the contract tranche),
      `helpers/seed.ts`, `j11:72`. Only 2 endpoint tags change here (`j03:85`, `j05:60`).
      Untouched: j02, j04, j06, j08, j09, j10, mobile.  [after #3]
- [ ] **#5** Docs for this tranche — `feature-spec.md` is heaviest (`:4,:6,:26,:39,:61,:63,:66,
      :84-89,:96,:99,:101-103,:117,:126,:206,:208,:212,:229-232,:274,:285-288,:294,:302`);
      plus `README.md:54,:68,:115-116,:122,:126,:132`; `CLAUDE.md:19`;
      `docs/features.md:70,:79`; `cupel-phases.md:18,:19,:26,:32-34,:61,:65,:138`;
      `docs/plan-ab-compare.md:17,:73-74,:107,:123,:132`; `docs/plan-cupel-cli.md:49-50,:105`
      (`run <id>` → `evaluation <id>` is a **naming decision**, not a replace).
      Fold in: fix `docs/index.html:296` (says 19 journeys, there are 13) and
      `README.md:116`'s wrong line citation.  [after #4]
- [ ] **#6** **GATE — revisit with the user.** #1–#5 shipped; re-examine whether the contract
      tranche (#14) still looks right before spending it. User asked for this checkpoint.

## Ready and small — bugs and residuals

- [ ] **#7** **Latent data-loss bug**: `EditorPage.tsx:99-128` tears the response into six form
      buffers and `save()` mutates them locally; the seed-on-data effect re-fires after a save
      and can clobber a draft the user is still typing (the Textarea is not disabled while
      saving). Needs the editor body extracted into a keyed child first.
- [ ] **#8** `useAsync` — two clean converts left: `ByokSection.tsx:67`, `CompareView.tsx:132`.
      The other five unconverted sites are deliberate (see `docs/open-items.md`).
- [ ] **#9** Make `RunConfigPanel`'s `initialFocus` and `judgeInitiallyOpen` controlled
      (`:119,:125-129`), then the remount-by-key drops to `key={i}`.
- [ ] **#10** Last render-phase ref write (`InspectorPage.tsx:192`), **and add a lint setup at
      all** — `eslint-plugin-react-hooks@7` (`recommended-latest`). There is no eslint config
      in the repo, so five `exhaustive-deps` disables are inert and enforce nothing. Do **not**
      enable the React Compiler (Vite/rolldown, no Babel — 4 deps to reintroduce a Babel pass).
- [ ] **#11** `docs/features.md:65` still marks whitelabel as planned (🗓️). It shipped.

## Before the UX phase

- [ ] **#12** **Test the studio-only hypothesis** (user, 2026-08-09): the wedge persona may
      never use the chat half — they have their own UI and want only the studio. If true, the
      first ten minutes end at "my agent's real traffic is being evaluated", not "my agent
      answered in a real UI", and the README leads with the other door. **Decides #13's shape.**
- [ ] **#13** **UX phase planning session — with the user.** Known inputs: lead with "bring
      your own agent" (`cupel-ready --init` is the on-ramp); no tree switcher exists, so
      cross-tree results cannot be linked; coverage gaps — no visual-regression testing at all,
      e2e runs against the Vite dev server and never the built bundle Render serves, chromium
      only, portrait filmed nowhere, and BYOK live mode / s3 restore / a11y+keyboard /
      SSE-drop / 5xx all untested.  [after #12]

## Contract and the phase after

- [ ] **#14** **Contract v0.4.0 — the big one. Runs before the CLIs, which generate from it.**
      Two halves in one bump:
      (a) *Review bucket C, 15 items*: uniform cursor-paginated `Page<T>` · conversations
      without inlined turns · run-grid pagination + ETag · `POST …/versions` replacing
      non-idempotent PUTs · readable version history (this is why the workbench cannot show
      history) · `GET /eval/cases` · `Idempotency-Key` on 202s · SSE event ids + `Last-Event-ID`
      · `/tasks/stream` subscription filters · per-operation permission semantics + 403s ·
      `Error.details[]`/`request_id` + 422/429/503 · batch turn fetch · `Health.contract_version`
      + capabilities · visible soft-delete · search semantics · span retention · close the
      mock's implementation gap. Plus two later gaps: six ops return 409 `tree_disabled`
      undeclared, and 422 is undeclared almost everywhere.
      (b) *The domain tighten, tranche 2* — **no backward compat** (unlaunched, private,
      unpublished, zero adopters; no shims, no aliases, no deprecation window):
        1. Rename `Run`→`Evaluation`, `run_id`→`evaluation_id`, `RunConfig`→`Variant`,
           `RunCell`→`Result`. 151 wire occurrences, 142 in `src/`, 28 in `e2e/`, 48 files.
           `scripts/conformance.mjs:47,48,59` and `tests/openapi-contract.test.js` move together.
        2. Merge `Casebook` and `EvalSet` into one noun (reference-vs-frozen becomes a field);
           **deletes `POST /casebooks/{id}/to-eval-set`**. Leave `Selection` alone.
        3. `Judgment` gains `subject{kind,id}` + `scorer{kind,ref,version}`; the four nullable
           keys go. Enables `scorer.kind=check` and pairwise preference later, without a bump.
        4. `Evaluation.status` becomes derived from its Task. Task owns lifecycle alone —
           precondition for the Idempotency-Key item and closes the two-tab double-judge residual.
        5. Fold in `ReplayTurnRequest.configs[]` (a config per endpoint) so one turn re-fire
           varies endpoint + version + model per column, and widen `endpoint_ids` beyond turn
           re-fire so an evaluation can vary the deploy target.
      **Collision to resolve first:** the `variants[]` key vs the new `Variant` type.
      **Do not rename** `docs/spike-agui.md:226-227,:401` — that is AG-UI's own `run_id`.
      **Artefacts this forces:** `docs/readiness.md:5` (version) and `:100-113` (the x/69 block);
      `docs/index.html:273`; `docs/spike-agui.md:495,:506`; `sketches/03,04,10*.svg` endpoint
      tags; `e2e/j13:160-168` (the "casebook becomes an eval set" step is deleted).
      **Must land before #28 (going public).**  [after #6]
- [ ] **#15** Persistence guidance — write `docs/persistence.md` (Postgres spine with
      partitioning + indexes, object storage for span payloads and attachments, ClickHouse/OTLP
      for span metadata, a durable workflow engine for the task queue, Redis for SSE fan-out and
      idempotency); add the "good shape, do NOT copy the physical layer" header to `mock/db.py`
      (which also has no indexes); add a schema-wide tenant/owner column (`conversations.user_id`
      exists but was added for the Inspector, not as that). Pairs with #21.
- [ ] **#16** Context policy widening — frozen/today/custom + fallback for envelope-less turns +
      recorded-tool playback. Contract already shipped; **implementation only**, 6 steps
      (`docs/plan-context-policy.md`). Key risk: frozen must stay the default when the field is
      omitted — assert in all three test layers.  [blocked: Q2]
- [ ] **#17** Generator control API + drip-rate settings (un-greys `SettingsPage.tsx:253,258,264`,
      which a test pins).  [after #14]
- [ ] **#18** Memory panel — view/edit/clear per tree, compaction as a visible queued task.  [after #14]
- [ ] **#19** k8s manifests + a Helm post-upgrade Playwright job that gates the release
      (artifacts + local validation, no live cluster).
- [ ] **#20** `cupel-cli` — terminal client to any conformant backend; chat with live token
      streaming, conversations/agents/instructions/replay/evaluations/judge/trace/tasks,
      `--json`. `docs/plan-cupel-cli.md`, 4 sub-tasks.  [blocked: Q9, Q10, Q11 · after #14]
- [ ] **#21** `agentic-app-maker` — project scaffolder; generates a runnable project and prints
      next steps; no backend given = the mock does everything. `docs/plan-agentic-app-maker.md`,
      5 sub-tasks.  [blocked: Q4, Q5, Q6, Q7, Q8 · after #14]

## The rest of the roadmap (free, like everything else — there is no paid tier)

- [ ] **#22** Agents as Code — GitHub connect, instruction changes as PR diffs, merge promotes
      the version live; mock git server. No free tool does this.
- [ ] **#23** Public sharing — anonymous tokenised links for conversations/turns, with expiry
      and revocation. Extends the in-app deep links; every shared conversation is a billboard.
- [ ] **#24** AG-UI bridge — spike done (`docs/spike-agui.md`), recommends adopt-partially via
      `mock/agui.py` on the existing `adapter?:` seam, ~400–600 LOC. Not a client transport, not
      a contract change.  [blocked: Q3 · after #14]
- [ ] **#25** Hybrid backend fill — implemented endpoints go to the adopter's backend, missing
      families to the bundled mock, table derived from the `cupel-ready` gap report, visible
      "served by mock" badges.  [blocked: Q4 — #21's `--gap-as-mock` may delete this]
- [ ] **#26** Studio: vary the deploy target in an evaluation — flip `RunConfigPanel`'s existing
      `showEndpoints` flag on for the stepper. UI half only; the contract half is in #14.  [after #14]
- [ ] **#27** Cross-backend compare — per-request target override in `src/api/client.ts`, N
      unrelated conversations in N databases. No shared evaluation id means the grid and judging
      do not apply for free. Overlaps #25 (same client refactor).  [blocked: Q1]

## Ops and housekeeping — user-owned, dashboard-side

- [ ] **#28** Decide repo visibility. Both repos private; going public is the point of the
      stars/community strategy. **This closes the no-back-compat window — do #14 first**, and
      the README/site should be launch-ready.
- [ ] **#29** Render hostname: the service was renamed `cupel-demo` but its hostname is still
      `skein.onrender.com` (Render pins the one minted at creation). Options: live with it,
      recreate the service (**carry `DEMO_TOKEN` over first** — it is `generateValue: true`, so
      a new service mints a different one and shared demo links die; the old hostname dies
      instantly with no redirect), or put a real domain in front. `cupel.io`/`cupel.sh` are free.
- [ ] **#30** Turn on demo persistence — the code shipped but the hosted demo still runs
      `CUPEL_STORAGE=local`, so a restart wipes it. Needs an R2/S3 bucket + scoped token, then
      the `CUPEL_S3_*` env vars. **The s3 path has never once executed** — the first real deploy
      is the test; `/healthz` `storage.mode` reports whether it degraded to local.

## Doc and code debt

- [ ] **#31** `react-migration.md` is dead weight — a Streamlit→React migration guide requiring
      an `INVENTORY.md` that does not exist, for a codebase with no Streamlit in it — and
      **`CLAUDE.md:3` still names it as the mandatory first read**, so it misleads every new
      session. Delete it and fix CLAUDE.md, or replace it with the evidence rules it was cited for.
- [ ] **#32** `cupel-phases.md` is stale in five places: `helm install cupel ./chart` (no
      `chart/` exists); a PR round-trip in the Phase-2 DoD (cancelled); `npm run dev` as the
      front door (it is `npm start`); `npx cupel-ready`/`npx create-agentic-app`/`cupel chat`
      (unpublished); and "Phase 4 = hosted multi-tenant platform", contradicted by
      `docs/features.md:86` "Not planned".
- [ ] **#33** Stale paid-tier language, contradicting the no-paid-tier decision:
      `src/lib/shareLink.ts:8`, `src/pages/ChatPage.test.tsx:985` ("PRO-2"),
      `docs/plan-agentic-app-maker.md:28,:171`. (`docs/deployment.md`'s "free tier" means
      Render's hosting plan — correct, leave it.)
- [ ] **#34** `feature-spec.md` has two wrong routes: `:32,:282` say `/agent-trees` (contract
      says `/agenttrees`); `:127,:151` say unscoped `/turns/{id}/trace` (actual route is
      tree-scoped).
- [ ] **#35** `docs/index.html:271-276` shows `npx cupel-ready …` as installable. The package is
      `private: true` and unpublished — only `npm run ready` and the local bin work.
- [ ] **#36** `docs/deployment.md:88,111-115,139-146` describes the R2 bucket and the s3
      boot/restore/`/healthz` behaviour as if configured and observed. None of it has ever run
      (see #30). Mark untested until it lands.
- [ ] **#37** The "69 operations" count is copy-pasted into three docs with no source of truth:
      `docs/spike-agui.md:495` is the authoritative breakdown, restated at
      `docs/readiness.md:108` and the public `docs/index.html:273`. Any contract change moves
      all three and nothing enforces it. Fix: derive it from `openapi.yaml` in the readiness
      script and stop hardcoding it in prose.
- [ ] **#38** The suite is not clean under **full** shuffle (files *and* tests within files).
      Two pre-existing failures, both reproducing in isolation: `parity.test.ts` registers a
      `response:mocked` listener in `beforeAll` that attributes every later request to whatever
      `currentApiMethod` last held; and `ChatPage.test.tsx > renders tokens incrementally`.
      File-order shuffle alone is green. Only worth fixing if you want the suite shuffle-clean.

## Ideas — not approved, not queued

- **Evaluation `intent` + `promoted_by_evaluation_id`** — two additive fields that would give
  the version history *evidence*: why each version exists and what score movement justified
  keeping it. The column-relabel hack (`types.ts:673-675`) already fakes half of this link.
  Additive, so unlike the renames it need not wait for #14.
- **A first-class "Change"/assay object** — intent, base, draft, cohort, evaluations, verdict,
  delta. Would make #22 a rendering of the core loop rather than a new subsystem, and give
  regression suites, thresholds and pairwise preference an owner. Only works if it is *inferred*,
  never ceremony.
- **Scorer kinds beyond the LLM judge** — deterministic checks (regex, JSON-schema,
  tool-was-called, latency/cost budget), pairwise preference, N-repetitions for variance,
  a human annotation queue. All are homeless today because `Rubric` *is* the scorer model.
  #14(b)3 is the precondition for all of them.

## Open questions — block the tasks named

| # | blocks | question |
|---|---|---|
| Q1 | #27 | Who judges a cross-backend compare, and how is that labelled? Nominate one backend as scorer, or judge client-side? |
| Q2 | #16 | `tools_mode: replay_recorded` on a turn whose trace has no tool spans — silent no-op or cell error? |
| Q3 | #24 | Also ship a thin client-side AG-UI adapter behind a "nothing is persisted" banner? Spike says no in the first pass. Re-read its five watch items before deciding. |
| Q4 | #21, #25 | Does `--gap-as-mock` make the hybrid fill redundant? Recommendation: yes — delete #25. |
| Q5 | #21 | What language is `create-backend`? Recommendation: FastAPI/Python first. |
| Q6 | #21 | Feature trimming (`--features no-evaluate`) — in or out? Recommendation: out. |
| Q7 | #21 | Does `--same-repo` touch git state? Recommendation: no, print a suggestion. |
| Q8 | #21 | Should the generated backend implement chat + conversations for real, not stubs? Recommendation: yes for those two. |
| Q9 | #20 | A `~/.cupel/config.json` for defaults? Recommendation: credentials only. |
| Q10 | #20 | Ship on npm as `npx cupel-cli`, or checkout-only? Recommendation: checkout-only first. |
| Q11 | #20 | `fav`/aliases? Recommendation: defer — needs Q9. |

---

Parked indefinitely: a hosted multi-tenant platform. Not on any roadmap.
Deliberately skipped, do not "fix": sidebar row virtualisation (rows are user-bounded behind
an explicit Load more); the three `test.skip` calls in j10/j11/j12 (they are `AUTH_E2E` gates);
`scripts/cupel-ready.mjs:203`'s literal `"TODO:"` string (intended output for the adopter);
`src/test/msw/parity.test.ts:655-665` (a deliberate registry of unimplemented operations).
