# Cupel — TODO

One list. Top to bottom. Numbered 1..N.

**If an item starts with DECIDE, it needs you, not a runner.** Everything else is work.
Commit as `N: <summary>`. Evidence lives in the item itself — there is no companion file.
(`open-items.md` was merged in here 2026-08-11; its retired ids — `PH-`, `PB-`, `PW-`,
`PAB-`, `P3-`, `P4-`, `C`, `D`, `Q` — survive only in git and in old commit messages.)
**A DONE item is deleted once its work is committed** — git is the record, and a task list
that is mostly finished tasks stops being a list. It leaves a one-line row in "Shipped"
below with its commit. Work that is done but still sitting in the working tree keeps its
full entry until it lands. **Numbers never shift and are never reused**, so `N` in a commit
always means `N` here, whether `N` is still an item or a Shipped row.

Invariants (never break): versions/judgments/snapshots append-only · generator writes only
via public API · /me always called · no AUTH_MODE branches · one config artifact.

Done this session (12 commits on `evaluations-rename`): the "Runs" concept is gone from the
UI, routes, e2e and docs; the sidebar is two doors (Chat + Evaluate); a real editor data-loss
bug is fixed; eslint exists for the first time. 620 tests green, tsc clean, lint clean.
Those items were `#1`–`#11` in the old scheme, and that is how the commits read.
**This list is open work only, renumbered from 1. Old numbers survive only in git.**

---

## Closed — do not re-investigate

- **Phase 1 and Phase 2**: complete. Every box checked.
- **Review bucket A** (8 items): all verified fixed in code, not just marked done.
- **Auto-judge fragility** (raised by P2-RECORD): fixed 2026-08-07, commit `3936794`. The rule
  is "done + judge in config + not already judged", read from the append-only store. Do not
  re-plan it.
- **Repo rename**: done 2026-08-08. `LampOfSocrates/cupel`, local remote re-pointed, and it
  made `docs/index.html`'s clone URL correct. Public since item 14.
- **Product name**: settled. Loom → Skein → **Cupel**, final. No "Skein"/"Loom" strings survive
  in the product docs; the last two elsewhere are item 33.
- **Paid tier**: there is none, ever (2026-08-07). Supersedes all earlier tiering. The old
  "Phase 4 pro shelf" is dissolved; its items are ordinary free roadmap work.
- **The scaffolder's five open questions** (old `Q4`–`Q8`): all answered by items 10 and 11
  shipping — backend language (Python/FastAPI), feature trimming (subsumed by `--family`),
  `--same-repo` (touches no git state), a real chat + conversations reference implementation,
  and static family-level gap filling, which is what `--family name=mine|mock|hide` IS. The
  hybrid runtime-routing task it would have made redundant was never carried onto this list.
- **Doc debt sweep of 2026-08-08** (old `D-1`…`D-12`): fully discharged. Every row is either
  done (lint setup, derived counts, the landing page's `npx` claims, `docs/index.html`'s
  journey count, `README.md`'s journey citation, `react-migration.md`) or a numbered item
  below — 13, 32, 33, 34, 36, 38. Nothing from it is untracked.

---

## Shipped — numbers retired, detail is in git

Each of these was DONE with commits behind it, so the prose is gone and `git show` is the
record. The numbers are listed because open items below still cite them, and because a
commit reading `N: …` has to resolve to something. **Numbers are never reused.**

| # | what shipped | commit |
|---|---|---|
| 2 | `ByokSection` + `CompareView` converted to `useAsync` | `dcd854e` |
| 3 | `RunConfigPanel`'s dead `initialFocus`/`judgeInitiallyOpen` props deleted | `9b4803e` |
| 4 | 226 `feature-spec.md` citations re-pointed past the preset deletion | `5401d37` |
| 5 | `react-hooks/set-state-in-effect` turned on; 21 sites reshaped or suppressed with reasons | `f9a48ac e9abb14 85ecc66 2d3820e` |
| 7 | **contract v0.4.0** — Run→Evaluation, Casebook→EvalSet, `Page<T>`, `POST …/versions`, the 404/403 permission split, structured errors | `b8ceaa0 + 19` |
| 11 | **`npm run create`** — one command writes a folder the adopter owns, one question per family | `798dca1 + 6` |
| 14 | `github.com/LampOfSocrates/cupel` made public | `d5ad801` |
| 15 | landing page and demo merged into ONE Render service, `DEMO_TOKEN` dropped | `a92075f` |
| 35 | landing page's `npx cupel-ready` block corrected | `cda9659` |
| 37 | contract counts derived (`npm run facts`) and enforced against living prose | `378be48` |
| 39 | **contract v0.5.0** — `EvalSet`→`EvalBenchmark`, `EvalCase.agenttree` | `7ff5217` |
| 44 | `cupel-run.sh` deleted — a dead runner: root-path guard for files that live in `docs/`, `^- [ ]` tasks this list stopped using, and a prompt naming a document that no longer exists | *in working tree* |

Also retired without shipping: **6** (Node port, dropped) · **18** (cross-backend judging,
dropped 2026-08-11) · **21** (the three CLI questions, dropped 2026-08-11) · **29** (vary the
deploy target in an evaluation, dropped 2026-08-11 — its dormant `showEndpoints` branch was
deleted from `RunConfigPanel` with it, so nothing unreachable is left behind) · **30**
(cross-backend compare, dropped 2026-08-11 — it depended on 18, which was already dropped) ·
**25** (`cupel-cli`, dropped 2026-08-11 — `docs/plans/plan-cupel-cli.md` deleted with it) ·
**27** (public tokenised sharing, dropped 2026-08-11 — free in-app deep links stay; it is the
ANONYMOUS public link with expiry and revocation that is not happening).

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
   **Corrected 2026-08-09 by item 7 stage E — that list and that count are both wrong.**
   Derived from the contract the families are its 14 top-level `tags`; the list above named
   `instructions` (never a tag of its own — it is `agents`) and omitted `memory`, `trees`,
   `admin`, `auth`, `identity` and `meta`. The merge moved 15 → 14, not ten → nine. Nothing
   else in the decision changes: the contract owns the vocabulary and `Health.capabilities`
   is where a backend answers with it.

6. **DROPPED 2026-08-09 (user) — we will never do the Node port.** Number reserved so
   nothing renumbers. Consequences, recorded so they are not rediscovered: Python 3.11+ stays a
   hard requirement for anyone running the bundled backend, including whatever item 11 generates;
   item 7's rename now spans two languages instead of one; and item 10's backend-language
   question reverts to Python/FastAPI, since the reference implementation stays Python.

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

12. Memory panel — view/edit/clear per tree, compaction as a visible QUEUED TASK, not a
    spinner. The last contracted but unbuilt family; leaving it stubbed makes the contract a
    lie to anyone running `cupel-ready`. Four operations, all declared and none served:
    GET/PUT/DELETE `/agenttrees/{tree}/memory` and POST `…/memory/compact`. The mock
    declares them `none` honestly in `mock/capabilities.py` and `src/test/msw/parity.test.ts`
    carries them in its deliberate unimplemented registry. Memory is the one store exempt from
    append-only — PUT overwrites, DELETE clears.

13. Persistence guidance — `docs/persistence.md` (Postgres spine, object storage for span
    payloads, ClickHouse/OTLP for span metadata, a durable workflow engine for the queue, Redis
    for SSE fan-out), the "do NOT copy the physical layer" header on the db module, and a
    schema-wide owner column. Item 11 shipped WITHOUT linking it (user, 2026-08-10) — a
    generated README must not point at a document that does not exist — so add the link to
    `scripts/generated-readme.mjs` as part of this item.

16. Turn on demo persistence — the code shipped in P2-PERSIST but the hosted demo still runs
    `CUPEL_STORAGE=local`, so a restart wipes it. Needs an R2/S3 bucket + scoped token, then
    `CUPEL_STORAGE=s3` plus `CUPEL_S3_BUCKET` / `_ENDPOINT` / `_ACCESS_KEY_ID` /
    `_SECRET_ACCESS_KEY` (optional `_PATH`, `_REGION=auto`). **That path has never once
    executed** — the first real deploy IS the test, and `/healthz` `storage.mode` is what
    reports whether it degraded back to local. Blocked on your credentials. Item 36 waits on
    it: `docs/deployment.md` describes the restore as if observed.

17. UX phase planning session — with you. Desktop-first, organised around the wedge persona's
    first ten minutes, ending with THEIR agent answering in a real UI rather than our demo
    with fake data. **Phase 3 begins only after this closes and you say so.**
    Inputs: lead with "bring your own agent" and `cupel-ready --init` as the on-ramp; there is no
    tree switcher, so cross-tree results cannot be linked; and the coverage gaps — no visual
    regression testing at all, e2e never runs the built bundle Render serves, chromium only,
    portrait filmed nowhere, BYOK live mode / s3 restore / a11y / SSE-drop / 5xx all untested.

19. **DECIDE — replaying recorded tools on a turn whose trace has no tool spans: silent no-op
    or cell error?** Blocks item 22.

20. **PARKED 2026-08-09 (user) — AG-UI is off the table for now.** Was: also ship a thin
    client-side AG-UI adapter? Revisit only if item 28 is ever unparked.

22. Context policy widening — replay under the original / today's / a custom context, plus a
    fallback for envelope-less turns and recorded-tool playback. Plan:
    `docs/plans/plan-context-policy.md`. **Contract already shipped in v0.3.0 —
    implementation only**, six steps, all unstarted. Key risk: frozen must stay the default
    when the field is omitted; assert it in all three test layers. Item 19 blocks the
    recorded-tools step.

23. Generator control API + drip-rate settings — un-greys the placeholders at
    `SettingsPage.tsx:253,258,264`, which a test at `SettingsPage.test.tsx:173` pins as
    deliberate, so this item has to edit that test too. POST `/admin/generator` and GET
    `/admin/generator/status` are the only two operations keeping the mock's `admin` family
    at 6/8 partial. The engine already exists — `mock/generator.py` has `seed()` and
    `drip()`, driven from the CLI by `npm run simulate` — so the work is a lifecycle owner
    for a long-running task inside uvicorn, not new generation logic, and it must keep writing
    through the public API. `feature-spec.md:186` also specifies a second surface nobody has
    built: Settings → Admin for a real backend, staging only, hidden in prod.

24. k8s manifests + a Helm post-upgrade Playwright job that blocks a bad release. Artifacts
    and local validation only — no live cluster.

26. Agents as Code — GitHub connect, instruction changes as PR diffs, merge promotes the
    version live. No free tool does this.

28. **PARKED 2026-08-09 (user).** AG-UI bridge — a server-side adapter so an agent already
    speaking AG-UI needs no new endpoints. Spike is done and stays valid (`docs/spike-agui.md`);
    nothing else depends on this, so parking costs nothing. Note item 9 partly covers the same
    need by cheaper means: accepting a bare agent endpoint serves an AG-UI agent too.

31. **DONE 2026-08-11 (user).** Deleted `react-migration.md` — a Streamlit→React guide for a
    codebase with no Streamlit, requiring an inventory file that does not exist. It was cited
    for its evidence rules, so those are now stated INLINE at the top of `CLAUDE.md` (quote the
    spec lines, cite file:line, check lockfiles, flag ambiguity) rather than pointed at; the
    numbered reading list drops to two. `cupel-phases.md`'s header and session opener no longer
    name it either. One dead mention survives on purpose: item 40's record quotes the doc's
    "prove this works" rule, and rewriting a shipped item's account of itself would be a lie
    about its own date (the rule itself lives on in `CLAUDE.md`).

32. **RESOLVED 2026-08-11 by item 42 — the document was deleted, not corrected.** It was
    stale in five places: a helm chart that does not exist, a cancelled PR round-trip,
    `npm run dev` as the front door, `npx` commands for an unpublished package, and
    "Phase 4 = hosted multi-tenant platform", which the features doc explicitly says is not
    planned. Fixing five errors in a document whose every remaining sentence was already
    duplicated elsewhere would have been maintaining a second copy of the truth.

33. **DONE 2026-08-11 — 10 stale tier strings removed across 7 files.** This item's own list
    was wrong in both directions, which is why the sweep was done by grep rather than by
    following it: `ChatPage.test.tsx:985` ("PRO-2") **was already gone**, and six sites it
    never named were still there — `src/lib/exportInstructions.ts`, `e2e/j13-authoring.spec.ts`,
    `openapi.yaml` (×2, including the contract's own "Pro-tier exclusions" paragraph),
    `tests/openapi-contract.test.js` (×2, one of them a TEST NAME), plus
    `src/pages/editor/InstructionEditor.tsx` and `src/pages/EditorPage.test.tsx` ("Free-tier
    export"). **The reason mattered more than the word**: repo/PR integration and tokenised
    share links are excluded from the contract because they are UNBUILT (items 26 and 27),
    not because they are paid, and the contract test asserting their absence now says so —
    its assertion behaviour is unchanged, only the justification. `x-requires`, schemas and
    every assertion are untouched; 67 operations still.
    **Not touched, deliberately:** the two mentions in `docs/plans/plan-agentic-app-maker.md`,
    which this item asked for. That document is SUPERSEDED and kept as the record of what was
    superseded — its own header says its counts are "left exactly as written" and
    `doc-counts.test.js` exempts it by name for that reason. Editing "P4-HYBRID = pro tier"
    out of a record of what was once decided would falsify the record, which is the same
    argument the file makes about its own arithmetic. Say the word if you want it rewritten
    anyway. Everything else that still says "free tier" is Render's HOSTING plan
    (`render.yaml`, `docs/deployment.md`, `mock/storage.py`) or a correct statement that no
    paid tier exists (`README.md`, `docs/features.md`, `docs/index.html`) — both kept.

34. **DONE 2026-08-11 (user).** Four sites, two defects: `GET /agent-trees` → `GET /agenttrees`
    (`:32`, `:279`) and the bare trace path → tree-scoped `GET /agenttrees/{tree}/turns/…/trace`
    (`:148`, `:291`); `:124`, `:225` and `:240` already had it right. Every fix is a
    substitution INSIDE an existing line and the file is still 300 lines, which is the whole
    constraint here: 701 places cite this file as `feature-spec.md:NNN`, so an edit that adds
    or removes a line silently invalidates every citation below it — that is what item 4 had to
    repair with 226 re-pointings.
    **Extended the same day (user), ahead of a Studio redesign**: the Studio sections and the
    whole UI × API grid were rewritten against contract v0.6.0 — `:39-66` is now "Studio — the
    evaluation workspace" (five tabs over four families), `:4` names the real doors, `:221-246`
    is a grid in which every one of the 40 API paths exists in the contract, and `:263` marks
    sketch 10 as stale rather than describing it as current. **Rewritten LINE-FOR-LINE**: 736
    citations point into this file and 466 of them sit below those ranges, so the replacement
    blocks are exactly as long as what they replaced and the bullet ORDER is preserved, which
    keeps the heavily-cited lines (`:49` 20 refs, `:64` 19, `:63` 16, `:59` 11) pointing at the
    same idea they always did. Zero citations re-pointed. The dead rows are gone with them:
    `…/runs/{baseline}`, `POST /assist`, `POST …/agents/{id}/pr`, `GET/PUT /settings/repo` and
    four `/casebooks/*` routes the contract test asserts are ABSENT; what is contracted but has
    no screen (memory, generator) is now one honest row instead of four rows pretending.
    A new **"Studio — the flow as it stands"** section is APPENDED after the old end of file —
    appending costs no citations — summarising the six-step path through the product and eight
    frictions found by reading the shipped code, the sharpest being that "Results" names both a
    tab and that tab's third step, and that the payoff screen (`/evaluations/{id}`) is a
    full-page route OUTSIDE the tab frame.
    Still open, and now the blocker for the redesign: **`sketches/10-eval-workbench.svg` and
    its `clean/` twin are wrong** — three tabs where the app has five, a "Sets" tab renamed to
    Benchmarks, and `GET /eval/sets` wired to a route that no longer exists.

36. `docs/deployment.md` describes the R2 bucket and s3 restore as if configured and observed.
    None of it has ever run (item 16). Mark it untested until it has.

38. **DONE 2026-08-11 (user) — the two named failures are fixed. Read the last paragraph
    before trusting the title.** Both were the same bug wearing different clothes: something a
    test started was still running after the test ended.
    (a) **`parity.test.ts` never switched its recorder off.** The `response:mocked` listener is
    registered in `beforeAll` to record what the exercises produce, and `currentApiMethod`
    holds the label to file them under. Neither was ever torn down, so every request made by
    any LATER test in the file was appended under the last error exercise's label. Invisible in
    declaration order — the readers run first — but under shuffle the 422 assertion read 57
    unrelated 200s. Fixed by removing the listener and clearing the label once the exercises
    finish, which is exactly the scope the recording was ever meant to have.
    (b) **`SettingsPage.test.tsx` walked away from a request it started.** "a stored custom
    target is selected and editable on revisit" points the app at `LOCAL_BASE` and asserts only
    synchronously, so the health check it triggers resolves after `afterEach` cleared
    `healthzRequests` — landing in the NEXT test's array, which then saw `["local", "mock"]`
    where it made one request. Fixed by awaiting its own side effect.
    The item's own description was stale: it named a `ChatPage.test.tsx` streaming test as the
    second failure. That one is green; `SettingsPage` is the real one.
    Verified by swapping only these two files out and back: identical test lists before and
    after, so the fixes removed no coverage. Ten shuffle seeds run (1, 2, 3, 5, 7, 11, 13, 21,
    42, 99) where seeds 1 and 3 previously failed.
    **The suite is NOT fully shuffle-clean, and this item is closed anyway on your call.**
    Seed 13 turns up a third failure of the same family — `Sidebar.test.tsx > Sidebar queue
    badge > counts pending parents and spins while running`, asserting a badge of 1 and seeing
    2, i.e. task fixtures from another test still in play. Reproduce with
    `npx vitest run --project ui --sequence.shuffle.tests=true --sequence.shuffle.files=true --sequence.seed=13`.
    Shuffle also stays OFF in `npm test`, so nothing stops the next one being written. The
    `contract` project (238 tests) is genuinely shuffle-clean and always was.

40. **DONE 2026-08-11 — `npm run create`'s terminal questionnaire replaced by a local
    browser mapper, plus path-remap rules real adopters need.** User-directed
    (item 11's family model — mine/mock/hide, one question per family — was kept exactly;
    only the delivery mechanism changed, confirmed by the user before building: browser
    over terminal, family-level not per-operation, terminal path stays as `--yes` for CI).
    (a) **The mapper**: `scripts/create-app-server.mjs` (plain Node `http`, ephemeral
    127.0.0.1 port, no new dependency) serves `scripts/create-app-ui/index.html` (one
    static file, vanilla JS, light/dark) and a small JSON API
    (`/api/bootstrap`, `/api/detect`, `/api/generate`, `/api/cancel`, `/api/ping`); opens
    the OS default browser (`start`/`open`/`xdg-open`), heartbeat-pings decide when the tab
    is gone (90s), `CUPEL_CREATE_NO_OPEN=1` skips the auto-open for headless/CI use. `--yes`
    is untouched — it never used the terminal prompts either, so it still writes with no
    browser and no prompt.
    (b) **A real ESM circular-import deadlock, found by actually running the CLI, not by
    review**: `create-app-server.mjs` importing back from `create-app.mjs` (the process
    entry point, which dynamically imports the server) left Node unable to finish
    evaluating either module — `node scripts/create-app.mjs` exited instantly with code 13
    ("Detected unsettled top-level await") and never printed the mapper's URL. Fixed by
    extracting every decision function into `scripts/create-app-core.mjs`, which neither
    the entry point nor the server statically depends on; `create-app.mjs` is now `export *`
    from it plus `main()` alone. Existing tests needed no changes (they import from
    `create-app.mjs`, which still re-exports everything) — this is the class of bug
    `docs/react-migration.md`'s "prove this works" rule exists for; a scripted driver
    (spawn the CLI, drive its HTTP API, assert exit 0) caught it where unit tests couldn't.
    (c) **Path-remap rules** (`scripts/remap-rules.mjs`) — a plain prefix (existing
    `cupel-ready --init` auto-detection) turned out not to cover real adopter shapes,
    surfaced mid-build by the user's own example: `/nabu-service/agent1/chat` +
    `/nabu-service/agent1/sessions` (root prefix, tree id with NO literal `agenttrees`
    segment, "conversations" renamed to "sessions") **and** `/nabu-service/agent1/stream`
    as chat's own SEPARATE streaming route rather than the contract's one endpoint + a
    `stream` body flag — explicitly required by the user ("you must support both /chat and
    /stream"), not left as a documented gap. One function
    (`buildRemapFn`/`renderRemapSource`, tested for behavioral equivalence against each
    other) composes prefix + drop-agenttrees + segment renames + a stream-route split, and
    doubles as `remapContract` for conformance comparison at generation time, so the
    suggested mine/mock answers reflect the adopter's REAL shape, not a guess. This forced
    one small, backward-compatible core change: `BackendTarget.remap` and `buildUrl()`
    gained a second argument (`{ stream }`, currently only chat) so a remap function CAN
    route differently for the streaming request — every other call site omits it, unchanged.
    `renderInitBlock` (cupel-ready.mjs) gained an optional `remapLines` override so a
    rules-based remap can replace its plain-prefix rendering without forking it; the
    existing `--prefix` auto-detection and its tests are untouched.
    32 new tests (776 vitest total, up from item 39's 744), tsc clean, lint clean.
    Manual proof, not just unit tests: a scripted driver spawns the real CLI headlessly
    and drives `/api/bootstrap` → `/api/detect` → `/api/generate` over HTTP, and a plain
    `--yes --json` run confirms the non-interactive path is byte-for-byte unchanged.
    Deliberately left out: `--yes`/CI flags for the new path rules (browser-only for now —
    a `--openapi-rules` flag is a small follow-up if CI ever needs it).
    (d) **The path rules are now EXTRACTED from the adopter's spec, not asked for** —
    user-directed follow-up ("extract it from their openapi.json"), which reverses the
    "deliberately left out" note above in the same session. The trigger was the question
    "what's this *One agent tree is called* business?": adopters think in `agent1`/`agent2`,
    not in Cupel's "agent tree", so asking them to name a concept they have never heard of
    was backwards. `extractAgentShape` (remap-rules.mjs) reads a spec's routes and derives
    the root prefix, every agent id, whether the contract's own `agenttrees` segment is
    present, whether chat streams on its own route, and **the noun itself** —
    `deriveTreeTerm(["agent1","agent2"]) === "agent"` (longest common prefix, falling back
    to common suffix for `support-bot`/`sales-bot` → `bot`, and to null rather than
    inventing a word). The id slot is found by scoring candidate depths against the
    CONTRACT's own resource names, so `/nabu-service/agent1/chat` picks `agent1` (tails
    `chat`, `stream`, `sessions`) over `nabu-service` (tails match nothing) — no path
    arithmetic, no hardcoded segment list. The browser page now shows a "Found in your
    spec" panel instead of a question, with the derived rules prefilled behind a collapsed
    "Path differences" override. Renames are the one thing NOT guessed: their `sessions`
    and our `conversations` are reported as unmatched on both sides for a human to pair,
    because a wrong guess writes a remap that silently points at the wrong route.
    **Two bugs this surfaced, both of which would have shipped as silent wrong answers,
    and neither of which unit tests found — a live run against a spec in the user's exact
    shape did**: (1) the comparator matches path TEMPLATES, so an ENUMERATED spec
    (`/nabu-service/agent1/chat` + `/agent2/…`) never matches the contract's `{tree}` and
    a backend implementing everything scored **0/67**, which then suggests `mock` for every
    family — the exact opposite of the truth. `foldTreeIds` collapses the enumerated ids
    back onto one `{tree}` path. (2) Folding alone was not enough: the enumeration IS the
    path parameter, so an enumerated spec declares none, and every folded operation then
    failed the "param 'tree' missing" check — still 0/67. Folding now synthesizes that
    parameter, with its NAME read from the contract rather than hardcoded. After both,
    the same spec reports a truthful 1/67 with `chat` partial (its `/upload` and
    `/feedback` really are absent). Proved end to end: detection → generated
    `agentic.config.ts` whose `remap` sends `/agenttrees/agent1/chat` to
    `/nabu-service/agent1/chat` and its streaming form to `/nabu-service/agent1/stream`,
    with `product.trees` reading `agent`/`agents` — none of it typed by a human.
    (e) **Chat is the anchor, and the whole document is accounted for** — the answer to
    "the openapi may contain loads of other endpoints, how to get people to focus".
    User-directed: *"look for any endpoints with /chat. That should give u the agent name
    as its XXXX/chat and then based on that agent name u can see what endpoints we have."*
    `chatAnchor` does exactly that — the segment before `chat` is an agent, everything
    before it is the prefix, majority wins so one stray `/chat` cannot hijack a big
    document. It replaces resource-scoring as the SELECTOR (scoring stays as the fallback
    for a backend whose chat route is named something else), and it is better on the two
    axes that matter here: deterministic, and explainable in one sentence to someone
    staring at a 300-endpoint spec. Chat is the right anchor because it is the one thing
    every adopter who has any reason to be here already has — it is the wedge and stage 1
    of the ladder. Two supporting pieces, because focusing SILENTLY reads as giving up:
    the shape now carries `usedPaths`/`ignoredPaths`/`pathsTotal` so the page says
    "used 9 of 28 paths — the other 19 aren't agent routes" with the list one click away,
    and `alternatives` (the runner-up slots) render as one-click corrections that re-derive
    everything for the chosen slot, so a mispick on an unfamiliar spec costs a click rather
    than a hand-written remap. Proved on a 28-path enterprise fixture carrying a deliberate
    decoy (`/v1/orgs/{org}/agents` — a path whose resource name the contract genuinely
    knows): the anchor picks `/nabu-service` + `agent1`/`agent2`/`agent3`, term `agent`,
    ignores the other 19, offers `/v1/orgs` as the one alternative, and clicking it
    round-trips to `foundVia: "your correction"` with the original pick now offered back.
    One bug fixed on the way: after clicking an alternative the page would post the
    PREVIOUS pick's prefilled rules, which the server reads as "the human edited these"
    and so suppressed re-deriving for the slot just chosen — the fields are cleared first,
    and an auto-filled tree term is tracked (`treeTermAuto`) so a re-pick replaces it while
    a hand-typed one survives.
    805 vitest, tsc clean, lint clean.

41. **DONE 2026-08-11 — contract v0.6.0: the `eval` family split, `evaluations` renamed
    to `replay`.** User-directed after a contract review, and like item 39 it overrides
    the Phase-2 FULL STOP — logged here rather than skipped. A FAMILY-only change: no
    path, schema, operation or field moved, so the 67/52 operation/path counts are
    unchanged and every URL a backend serves is untouched. Families went 14 → 15.
    The review found three faults and this fixes two of them; the third
    (`/upload` + `/feedback` sitting in `chat`, which the bare-agent persona answers
    `mine`) was deliberately left, along with splitting generator control out of `admin`.
    (a) **`eval` (19 operations) split at the seam a backend actually implements on** —
    `datasets` (what is evaluated: cases ×4 and the eval benchmarks holding them ×9 = 13)
    and `judging` (what does the evaluating: rubrics ×3, `POST /eval/judge`,
    `GET /eval/judgments`, the score summary = 6). It was 28% of the contract behind one
    mine/mock/hide answer, and `suggestAnswers` downgrades anything short of `full` to
    `mock`, so a backend with its own case store but no judge got the whole workbench
    mocked.
    (b) **`evaluations` → `replay`** — four characters from `eval` and a different family.
    All three names are now distinct.
    (c) **`judging` earns a door, or the split would repeat the flaw it fixes.** /studio
    merged two families through a bespoke `isStudioHidden()` escape hatch; it now merges
    three (`STUDIO_FAMILIES` in `src/lib/families.ts`) and each tab gates on its own —
    Cases/Benchmarks on `datasets`, Rubrics on `judging`, Results on `replay`. Hiding
    `judging` takes the Rubrics tab and nothing else.
    Bumped `0.5.0`→`0.6.0`: `openapi.yaml`, `mock/capabilities.py`, `mock/permissions.py`,
    `tests/openapi-contract.test.js`, and the `v0.5.0` mention in `docs/readiness.md`.
    `src/api/families.generated.ts` regenerated; `ASK_ORDER`/`SCREEN_FAMILIES` updated in
    both the CLI (`create-app-core.mjs`) and the browser mapper (`create-app-ui/index.html`);
    `docs/plans/plan-adopter-onboarding.md`, `scripts/create-app.mjs` and
    `scripts/create-app-server.mjs` moved off "14 families" — `tests/doc-counts.test.js`
    found all four prose sites, which is what it exists for.
    794 vitest green (three of them new family-gating cases; the rest of the rise over
    item 40's 776 is item 40's own in-flight work, which landed alongside this).
    tsc clean, lint clean. `test_declared_capabilities_match_the_contract` passes, which
    is what proves `mock/capabilities.py` matches the new tag partition rather than my
    arithmetic. The two pre-existing pytest failures (item 39) still fail, unrelated and
    untouched.

42. **DONE 2026-08-11 — `docs/cupel-phases.md` deleted, and its 151 citations with it.**
    User-directed, and the deciding question was theirs: *"why have these citations at all
    in code?"* Three things were true at once — the doc's content was duplicated
    (`feature-spec.md` is "the what", `CLAUDE.md` carries the invariants, the mock and its
    pytests are the truth about the mock), it was stale in five known places (item 32), and
    it was nonetheless the target of 151 `cupel-phases.md:NN` references across ~40 files.
    **The rule applied to every one of them: keep the explanation, delete the pointer.**
    `// remap first (cupel-phases.md:75 — differently-named routes)` becomes
    `// remap first (differently-named routes)` — the phrase carries the reason, the line
    number carries nothing a reader can use and rots the moment a paragraph moves. Quoted
    prose was kept verbatim wherever it explained a WHY; only the attribution went.
    Citations to `openapi.yaml:NN` and `feature-spec.md:NN` were deliberately left alone:
    those point at artifacts a reader can verify and a test can guard, which is exactly what
    a prose line number is not. `CLAUDE.md` now states that distinction as a standing rule,
    so the habit does not grow back, and its reading list drops to `feature-spec.md`.
    The evidence for the rule is in this file: item 4 re-pointed **226** such citations
    across 83 files after one document lost five lines. That is the tax being retired.
    Also updated: `README.md` (the "phase by phase" link became the readiness guide),
    `docs/readiness.md` (4), and item 32 above. Item 31's DONE record keeps its mention of
    the doc — rewriting a shipped item's account of itself would be a lie about its own date.

43. **DONE 2026-08-11 — stale contract-version pins in `mock/` corrected.** Found while
    doing item 42: seven docstrings and comments claimed the contract was v0.2.0 or v0.3.0
    (it is v0.6.0) — `mock/main.py`'s module docstring ("implements openapi.yaml v0.2.0
    exactly"), `mock/config.py` (which also claimed there is no `/settings` endpoint, and
    there has been one since Phase 2), and the "Contract under test (openapi.yaml v0.3.0)"
    headers of `test_admin.py`, `test_permissions.py` and `test_ready.py` (×3).
    **The fix is to stop pinning a version in prose at all**, the same lesson as item 42:
    `mock/main.py` now points at `mock/capabilities.py`, which holds `CONTRACT_VERSION` and
    the per-family map and is recomputed from the contract by a pytest, so it cannot go
    stale. Five OTHER version mentions were left exactly as they are because they are
    historical statements, not current-state claims — "v0.3.0 widened the oneOf",
    "`EvalCase.agenttree` added after v0.4.0", "v0.3.0 had exactly one per-METHOD
    exemption". Those are true and dating them is the point.
    **Why this rotted unnoticed:** `tests/doc-counts.test.js` guards living prose in
    `docs/`, `scripts/` and the repo root, but not `mock/` — so Python docstrings drift
    unchecked. Extending the guard to `mock/**/*.py` is the obvious follow-up and is NOT
    done here.
    192 pytest pass (the two `financial_advisor` env-leak failures of item 39 are unrelated
    and still there), 806 vitest, tsc clean, lint clean.

---

Not on the list, deliberately: a hosted multi-tenant platform (parked indefinitely); sidebar
row virtualisation, the three `AUTH_E2E` skips, the `"TODO:"` string the readiness script
emits for adopters, and the unimplemented-operations registry in the parity test — all four
are correct as they are, do not "fix" them.
