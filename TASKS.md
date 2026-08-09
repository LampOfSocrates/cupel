# Cupel — TODO

One list. Top to bottom. Numbered 1..N.

**If an item starts with DECIDE, it needs you, not a runner.** Everything else is work.
Commit as `N: <summary>`. Detail and evidence live in `docs/open-items.md`.
Done items stay in place marked DONE — **numbers never shift**, so `N` in a commit always
means `N` here.

Invariants (never break): versions/judgments/snapshots append-only · generator writes only
via public API · /me always called · no AUTH_MODE branches · one config artifact.

Done this session (12 commits on `evaluations-rename`): the "Runs" concept is gone from the
UI, routes, e2e and docs; the sidebar is two doors (Chat + Evaluate); a real editor data-loss
bug is fixed; eslint exists for the first time. 620 tests green, tsc clean, lint clean.
Those items were `#1`–`#11` in the old scheme, and that is how the commits read.
**This list is open work only, renumbered from 1. Old numbers survive only in git.**

---

1. **DECIDED 2026-08-09 — the contract plan stands, with three amendments.**
   (a) The merged noun is **`EvalSet`** — familiar to adopters, even though it will hold live
   references as well as frozen cases. (b) **Membership is versioned**, taking the eval-set
   policy rather than the casebook one: judgments reference sets, so membership must be
   reproducible. Consequence to design for — casebook editing quietly becomes "append a new
   membership version", which the UI does not model today. (c) **The contract declares its
   families** (chat · conversations · agents · instructions · evaluations · trace · tasks ·
   eval · settings), because `cupel-ready` and item 11's `--family <name>=mine|mock|hide` both
   need those names and would otherwise each invent their own. Additive; fits with
   `Health.capabilities`. Note the merge drops the family count from ten to nine.

2. **DONE `dcd854e`** — Two `useAsync` converts — `ByokSection.tsx:67`, `CompareView.tsx:132`. The other five
   unconverted sites are deliberate; leave them.

3. **DONE `9b4803e`** (deleted, not made controlled — both props had no caller). `RunConfigPanel`: make `initialFocus` and `judgeInitiallyOpen` controlled, then the
   remount-by-key drops to `key={i}`. Both props are dead since the presets were deleted.

4. **DONE `5401d37`** — 226 citations re-pointed across 83 files, plus the stale quotes. Fix the spec citations. Deleting the dead preset passages shortened `feature-spec.md` by 5
   lines, so **206 `feature-spec.md:NNN` citations are off** — old 104–293 → −4, old 295–305 →
   −5, old 1–103 unchanged. Also `e2e/j05-judge.spec.ts:7` quotes `'Score this run'`, a button
   string that no longer exists anywhere.

5. **DONE `f9a48ac` `e9abb14` `85ecc66` `2d3820e`** — 21 sites, 12 reshaped, 9 suppressed individually with reasons. Turn `react-hooks/set-state-in-effect` back on — **20 sites across 18 files**, currently
   disabled in `eslint.config.js` with the list inline. Left off, the new lint enforces less
   than it appears to.

6. **DROPPED 2026-08-09 (user) — we will never do the Node port.** Number reserved so
   nothing renumbers. Consequences, recorded so they are not rediscovered: Python 3.11+ stays a
   hard requirement for anyone running the bundled backend, including whatever item 11 generates;
   item 7's rename now spans two languages instead of one; and item 10's backend-language
   question reverts to Python/FastAPI, since the reference implementation stays Python.

7. **IN PROGRESS — staged.** Stage A DONE 2026-08-09 (`79739f5` rename · `9a21a92` citations ·
   `5636f56` e2e id prefix): the wire says Evaluation, the SQLite schema was migrated with it,
   and openapi.yaml's 310 drifted feature-spec citations are re-pointed. Version line still
   reads 0.3.0 — one bump at the end of all stages. Remaining stages: B `EvalSet` merge
   (versioned membership) · C `Judgment` subject/scorer · D derived status · E declared families
   · F the bucket-C breaking subset. Found during stage A, fold in where noted:
   **(i)** `feature-spec.md` still says `/runs` and `run_id`, and openapi.yaml quotes it — fix by
   **in-place word substitution only**; any line-count change re-breaks the 310 citations just
   fixed plus 206 in `src/`. **(ii)** `sketches/03-config.svg` and `04-results.svg` still show
   the old endpoint tags, and the sketches are the source the e2e tags mirror. **(iii)**
   `Task.result` carries an undeclared `evaluations` key (pre-existing) — bucket C.
   **(iv)** e2e encodes the mock's id prefix as if it were contract (`waitForURL(/eval_/)`).
   Stage B DONE 2026-08-09 — **Casebook and EvalSet are one noun, `EvalSet`.** A member is a
   reference to a live turn or a frozen case (`EvalSetItem.kind`); membership is versioned for
   both kinds; `POST /casebooks/{id}/to-eval-set` is deleted and materialising is
   `POST /eval/sets/{id}/freeze` flipping items in place. Nine `/casebooks` operations plus
   three `/eval/sets` ones became nine on the merged noun, so the contract went 69 → 66
   operations and ten families → nine (the `casebooks` tag is gone). The Casebooks page and
   `/casebooks` route are deleted; the Eval workbench's Sets tab is the one surface, and ⊞
   collect posts into a set. SQLite migrated: `eval_sets` splits into mutable metadata plus
   append-only `eval_set_versions`, and each old casebook becomes a set whose v1 holds its
   turn references. Found during stage B, **not fixed**: **(v)** the `openapi.yaml:NNN`
   citations in `src/` and `mock/` are ALREADY stale independent of this stage — e.g.
   `mock/engine.py:387` cites `openapi.yaml:1540-1546` for frozen context, which at the
   previous HEAD was the eval-set PUT body. Only the `feature-spec.md:NNN` citations inside
   `openapi.yaml` are maintained (item 4, stage A). Re-pointing the other direction is its own
   task. **(vi)** `docs/plan-adopter-onboarding.md:26` still lists `casebooks` as a family;
   stage E owns the family list.

7. **Contract v0.4.0.** Fifteen correctness fixes (paging, readable version history,
   idempotency keys, SSE resume, permission semantics, structured errors, batch turn fetch,
   soft delete, search semantics, span retention…) **plus** the domain tighten: `Run`→
   `Evaluation` on the wire, Casebook+EvalSet merged into one noun, `Judgment` gains
   `subject`/`scorer`, `Evaluation.status` derived from its Task. No backward compatibility —
   nothing is published and nobody has adopted it. **After item 6, so the rename is
   type-checked. Before item 14, which closes that window.**
   **`variants: Variant[]` — settled 2026-08-09 (user).** `RunConfig` already carries the
   endpoint, so a renamed `Variant` IS one column and needs no `{endpoint_id, config}` wrapper.
   Both entry points then take the identical `variants: Variant[]`, so turn re-fire stops being
   a different shape from a conversation replay. Consequence: `endpoint_ids` (plural) becomes
   `endpoint_id` (singular) — the plural only existed to express a fan-out `variants[]` now
   expresses properly. There was no naming collision; ignore earlier notes claiming one.
   Also drifted and belonging here: **310 `feature-spec.md:NNN` citations inside `openapi.yaml`**
   (contract `description:` text, so out of item 4's comments-only scope).

8. **DECIDED 2026-08-09 — a COPY.** Template the files into their folder; they own and can
   edit everything. Free to build and works today while the package is private. **The generated
   README must say plainly that they will not receive upstream fixes** — that is the cost they
   are consenting to, and burying it would be dishonest. Revisit publishing only once real
   adopters exist and you know what they actually customise.

9. **DECIDED 2026-08-09 — BOTH: a bare agent endpoint or an OpenAPI document.** "Where does your
   agent answer, and how does it stream?" is the wedge persona's entry, since they have a
   framework agent on HTTP and no spec at all. ~1 week: stream-shape declaration/detection, a
   shim mapping their endpoint onto the chat contract, tests, docs. Also recovers most of the
   parked AG-UI bridge's value at a fraction of its cost.

10. **DECIDED 2026-08-09.** Backend language: **Python/FastAPI**, settled by dropping item 6 —
    the reference implementation stays Python, so the generated backend should match it.
    The generated backend **implements chat + conversations for real**, stubs elsewhere, so the
    adopter has a working example of the intended shape rather than a folder of NotImplemented.
    **Families are selectable from the CLI, not only interactively** (user addition) — and that
    subsumes feature trimming: `--family eval=hide` answers the question AND drops the feature,
    so there is no second flag surface to design or test. Flags win over prompts; prompt only
    for families the flags left unanswered; support a fully non-interactive run for CI.
    **`--same-repo` never touches git state** — print a suggestion instead.

10b. **DECIDED 2026-08-09 — the generated folder BUNDLES the Python mock**, and the tech check
    **states the Python 3.11+ prerequisite before generating**, not at first run. A JS/TS agent
    developer meeting an unannounced pip install is the exact bounce this flow exists to prevent;
    if the dependency cannot be removed it must at least be declared up front.

11. **One command → `<name>-ui/`.** Clone → one command → a folder that `npm run`s a chat +
    studio UI. Checks the tech stack, optionally takes your backend's OpenAPI, asks **per
    family** (~10 questions) with three answers — **mine / mock / hide** — and mocks the rest
    with a "served by mock" badge — bundled Python mock, prerequisite declared up front (10b).
    Answers come from `--family <name>=mine|mock|hide` flags or, for whatever the flags leave
    unanswered, an interactive prompt; a fully non-interactive run must work for CI. Accepts a
    bare agent endpoint as well as an OpenAPI document (9). The folder is a COPY they own (8),
    and its README says so. Then a staged hook-up guide: chat only (one endpoint, their
    agent in a real UI within the hour) → conversations + turns → agents/instructions/versions
    → evaluations + traces. Plan: `docs/plan-adopter-onboarding.md`.

12. Memory panel — view/edit/clear per tree, compaction as a visible job. The last contracted
    but unbuilt family; leaving it stubbed makes the contract a lie to anyone running
    `cupel-ready`.

13. Persistence guidance — `docs/persistence.md` (Postgres spine, object storage for span
    payloads, ClickHouse/OTLP for span metadata, a durable workflow engine for the queue, Redis
    for SSE fan-out), the "do NOT copy the physical layer" header on the db module, and a
    schema-wide owner column. **Item 11 is supposed to point adopters at this**, so it should
    exist by then.

14. **DECIDE — go public.** Both repos are private. This is the launch, and it closes the
    no-backward-compatibility window, so item 7 must be done and the README/site ready.

15. **DECIDE — the Render hostname.** The service is named `cupel-demo` but its hostname is
    still `skein.onrender.com`. Live with it, recreate the service (**carry `DEMO_TOKEN` over
    first** — a new service mints a different one and shared demo links die; the old hostname
    dies instantly with no redirect), or put a real domain in front. `cupel.io`/`cupel.sh` free.

16. Turn on demo persistence — the code shipped but the demo still runs local storage, so a
    restart wipes it. Needs an R2/S3 bucket + scoped token. **That path has never once
    executed**; the first real deploy is the test.

17. UX phase planning session — with you. Inputs: lead with "bring your own agent"; there is no
    tree switcher, so cross-tree results cannot be linked; and the coverage gaps — no visual
    regression testing at all, e2e never runs the built bundle Render serves, chromium only,
    portrait filmed nowhere, BYOK live mode / s3 restore / a11y / SSE-drop / 5xx all untested.

18. **DECIDE — who judges a cross-backend comparison, and how is that labelled?** Nominate one
    backend as scorer, or judge client-side. Blocks item 30.

19. **DECIDE — replaying recorded tools on a turn whose trace has no tool spans: silent no-op
    or cell error?** Blocks item 22.

20. **PARKED 2026-08-09 (user) — AG-UI is off the table for now.** Was: also ship a thin
    client-side AG-UI adapter? Revisit only if item 28 is ever unparked.

21. **DECIDE — the three CLI questions.** A `~/.cupel/` config file for defaults (recommend
    credentials only) · publish to npm or checkout-only (recommend checkout-only first) ·
    aliases (recommend defer). Blocks item 25.

22. Context policy widening — replay under the original / today's / a custom context, plus
    recorded-tool playback. Contract already shipped; implementation only, six steps. Frozen
    must stay the default when the field is omitted — assert it in all three test layers.

23. Generator control API + drip-rate settings — un-greys the placeholders in Settings.

24. k8s manifests + a Helm post-upgrade Playwright job that blocks a bad release.

25. `cupel-cli` — drive any conformant backend from the terminal: chat with live streaming,
    conversations, agents, instructions, replay, evaluations, judge, trace, tasks, `--json`.

26. Agents as Code — GitHub connect, instruction changes as PR diffs, merge promotes the
    version live. No free tool does this.

27. Public sharing — anonymous tokenised links for conversations and turns, with expiry and
    revocation. Every shared conversation is a billboard.

28. **PARKED 2026-08-09 (user).** AG-UI bridge — a server-side adapter so an agent already
    speaking AG-UI needs no new endpoints. Spike is done and stays valid (`docs/spike-agui.md`);
    nothing else depends on this, so parking costs nothing. Note item 9 partly covers the same
    need by cheaper means: accepting a bare agent endpoint serves an AG-UI agent too.

29. Vary the deploy target in an evaluation — flip an existing flag on the stepper. UI half
    only; the contract half is in item 7.

30. Cross-backend compare — compare two separate backends. No shared evaluation id, so the grid
    and judging do not apply for free.

31. Delete `react-migration.md` — a Streamlit→React guide for a codebase with no Streamlit,
    requiring an inventory file that does not exist. **`CLAUDE.md:3` still names it as the
    mandatory first read**, so it misleads every new session. Fix that line too.

32. `cupel-phases.md` is stale in five places: a helm chart that does not exist, a cancelled PR
    round-trip, `npm run dev` as the front door, `npx` commands for an unpublished package, and
    "Phase 4 = hosted multi-tenant platform", which the features doc explicitly says is not
    planned.

33. Delete the stale paid-tier strings — `shareLink.ts:8`, `ChatPage.test.tsx:985` ("PRO-2"),
    and two in the scaffolder plan. There is no paid tier.

34. `feature-spec.md` has two wrong routes: `/agent-trees` should be `/agenttrees`, and the
    trace path is tree-scoped, not bare.

35. `docs/index.html` shows `npx cupel-ready` as installable. The package is private and
    unpublished — only the local bin works.

36. `docs/deployment.md` describes the R2 bucket and s3 restore as if configured and observed.
    None of it has ever run (item 16). Mark it untested until it has.

37. Stop hardcoding counts in prose. "69 operations" is copy-pasted into three docs with no
    source of truth, and `docs/index.html` claims 533 unit tests where the suite now reports
    620. Derive both, or delete them.

38. Make the suite clean under full shuffle — two pre-existing failures, both reproducing in
    isolation: a listener in `parity.test.ts` that misattributes later requests, and one
    streaming test in `ChatPage.test.tsx`. File-order shuffle alone is already green.

---

Not on the list, deliberately: a hosted multi-tenant platform (parked indefinitely); sidebar
row virtualisation, the three `AUTH_E2E` skips, the `"TODO:"` string the readiness script
emits for adopters, and the unimplemented-operations registry in the parity test — all four
are correct as they are, do not "fix" them.
