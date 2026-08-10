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
   **Corrected 2026-08-09 by item 7 stage E — that list and that count are both wrong.**
   Derived from the contract the families are its 14 top-level `tags`; the list above named
   `instructions` (never a tag of its own — it is `agents`) and omitted `memory`, `trees`,
   `admin`, `auth`, `identity` and `meta`. The merge moved 15 → 14, not ten → nine. Nothing
   else in the decision changes: the contract owns the vocabulary and `Health.capabilities`
   is where a backend answers with it.

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

7. **DONE 2026-08-10 — contract v0.4.0 shipped.** Eight stages, 20 commits, `0.3.0`→`0.4.0`.
   A rename (Run→Evaluation, schema migrated with it) · B Casebook merged into EvalSet with
   versioned membership · C Judgment reshaped to `{subject, scorer, evaluation_id?}` · D status
   derived from the owning task · E 14 families declared as tags + `Health.capabilities` ·
   F1-F3 one offset `Page<T>`, conversations without inlined turns, grid paging + ETag ·
   F4 `POST …/versions` for the four appenders · F5 permissions split (404 hides trees, 403
   explains capability) · F6 visible soft delete · F7 `details[]`/`request_id`, 26 undeclared
   status codes fixed, real 429 · F8 search semantics defined.
   67 operations · 14 families · mock implements 59. **653 vitest / 194 pytest / e2e 15+5.**
   Bugs found and fixed on the way, none of them the point of the stage that found them:
   `run_batch` finished a partly-failed batch `done` while `retry_failed` finished the same
   batch `failed` · the UI inferred "parent deleted" from a 404, the same 404 an unknown id
   and an unpermitted tree answer · a BYOK user over the rate limit was silently served mock
   text under their own key · `%` and `_` leaked into SQL `LIKE`, and case-folding disagreed
   between the two sides so **every non-ASCII conversation was unfindable** · MSW searched
   titles while the mock searched titles *or* turn content, undetectable until F8 wrote the rule.
   Deferred, logged in `docs/open-items.md`: readable version history (the `…/versions`
   sub-collections now exist but have no GET) · cross-conversation batch turn fetch ·
   `Idempotency-Key` on 202s · SSE event ids + `Last-Event-ID` · span retention ·
   eval-set tree scope (a judgment can name a case outside the set version it ran against) ·
   four collections deliberately unpaged because paging them needs real UX (item 17) ·
   `POST /agenttrees` grants its creator no permission on the tree they just made.

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

11. **DONE 2026-08-10 — `npm run create` writes a folder the adopter owns.** Seven commits
    (`7b5f43f` … `e7d0b5d`), the last two the persona-facing landing page and its bookkeeping.
    The family question needed a runtime that could answer it, so first: the path→family
    table is DERIVED from the contract's tags (`scripts/gen-families.mjs` →
    `src/api/families.generated.ts`, drift-tested), `agentic.config.ts` gained
    `families`/`mockTarget`/`agentEndpoint`, and `buildUrl` routes per family — one app,
    two backends, the adopter's and the bundled mock. `hide` removes the door AND the route
    (an unmatched path now lands on the front door instead of a blank frame, and the front
    door moves when chat is hidden); `mock` wears a per-screen badge naming the family.
    The generator itself: tech check with the Python 3.11+ prerequisite stated before
    anything is written (10b), one question per family with `--family` flags answering ahead
    of the prompts and `--yes` for CI, suggestions taken from the per-family conformance
    verdict (`full`→mine, anything less→mock), a refusal when the answers would leave no
    screens. Persona B is served: `--agent-endpoint [--stream sse|json]` writes
    `agentEndpoint` and `src/api/bareAgent.ts` maps chat onto it — SSE frames in the shapes
    frameworks emit (delta/token/content, OpenAI `choices`, plain text, `[DONE]`) or one JSON
    reply, ids minted client-side, conversations in tab memory until stage 2 (9).
    The folder is a COPY with no upstream fixes (8) and its README says so, states the
    prerequisite, and carries the four-stage ladder. **Proved: a generated folder typechecks,
    `vite build`s, and its copied mock boots and serves the seeded trees.**
    732 vitest green, tsc clean, lint clean. Deliberately left out: the generated copy
    carries no test suite (Cupel's own suites assert Cupel's family answers), and item 13's
    persistence guidance is NOT linked from the generated README — write 13, then add it.

12. Memory panel — view/edit/clear per tree, compaction as a visible job. The last contracted
    but unbuilt family; leaving it stubbed makes the contract a lie to anyone running
    `cupel-ready`.

13. Persistence guidance — `docs/persistence.md` (Postgres spine, object storage for span
    payloads, ClickHouse/OTLP for span metadata, a durable workflow engine for the queue, Redis
    for SSE fan-out), the "do NOT copy the physical layer" header on the db module, and a
    schema-wide owner column. Item 11 shipped WITHOUT linking it (user, 2026-08-10) — a
    generated README must not point at a document that does not exist — so add the link to
    `scripts/generated-readme.mjs` as part of this item.

14. **DONE 2026-08-10 — `github.com/LampOfSocrates/cupel` is public.** The
    no-backward-compatibility window is closed: the contract is v0.4.0 in the open, and a
    breaking change now costs somebody something. What the launch actually took, none of it
    the flip itself: `master` was 74 commits behind (`origin/master` at `eb0aa39`, Aug 7 —
    no v0.4.0, no scaffolder), so it was fast-forwarded to `evaluations-rename` and pushed;
    the repo was already NAMED cupel and only its description still said Skein; a secret
    scan of the tree and the whole history found nothing, and `.env` is now ignored anyway.
    **The launch blocker nobody had seen: `core.autocrlf=true` — the Git for Windows default
    — gave the checkout CRLF, and vitest cannot parse the CRLF form of the script modules
    whose templates emit regex literals. Five suites died, including the family-table drift
    test. `git clone && npm test` was a false instruction for every Windows adopter.**
    `.gitattributes` pins the working tree to LF; proved by cloning the public repo fresh
    (`i/lf w/lf`, 737 tests green). The local folder is `Code\2026\cupel` now, and the second
    repo item 14 used to mention stays private (user, 2026-08-10).

15. **DONE 2026-08-10 (code) — merged the landing page and the demo into ONE Render service,
    dropped the token gate; dashboard consolidation still pending (user).** Was two services:
    a Docker demo whose hostname had drifted to `skein.onrender.com` (blueprint said
    `cupel-demo`) and a standalone static-site landing page at `cupel-site.onrender.com`.
    Now one origin: `mock/root.py` serves `docs/index.html` at `/` and mounts the whole demo
    (API + built SPA, `mock/main.py` completely unmodified) at `/cupel-demo` via Starlette
    `Mount` — the prefix strips automatically, so `/cupel-demo/openapi.json` works via FastAPI's
    own `root_path` handling with no route table changes. `vite.config.ts` builds with
    `base: "/cupel-demo/"` (build-only) and `src/main.tsx` sets the router `basename` to match
    in production; the demo's sidebar carries a plain link back to the landing page.
    `render.yaml`'s service renamed `cupel-demo` → `cupel-site` to target the surviving
    hostname. The `DEMO_TOKEN` shared-token gate (middleware, cookie, `?token=` URLs) is
    deleted entirely — Phase-1 demo data isn't sensitive, so there is nothing to gate.
    **Remaining, dashboard-only**: delete the old `skein.onrender.com` Docker service and the
    old standalone `cupel-site` static site, then apply the renamed blueprint fresh — see
    docs/deployment.md "Consolidating the two existing Render services into this one".

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

35. **DONE 2026-08-10 `cda9659`** — the landing page's `npx cupel-ready` block is now
    `npm run ready --`, and `README.md:76` said the same thing and was fixed with it. Other
    `npx` claims survive in `cupel-phases.md` (item 32) and `docs/plan-agentic-app-maker.md`.

36. `docs/deployment.md` describes the R2 bucket and s3 restore as if configured and observed.
    None of it has ever run (item 16). Mark it untested until it has.

37. **DONE 2026-08-10** — counts are derived and enforced. `cda9659` deleted the landing
    page's four hand-copied numbers (533 unit tests, 160 backend tests, 13 journeys, 66
    operations) for claims that do not rot. Then `scripts/contract-facts.mjs` (`npm run
    facts`) became the source of truth — 67 operations · 52 paths · 14 families, read from
    `openapi.yaml` — and `tests/doc-counts.test.js` fails the build when living prose
    disagrees. It found the two sites nobody had noticed: `docs/readiness.md:154` and
    `docs/plan-adopter-onboarding.md:23` still said `/66`. Subset counts ("422 on 38
    operations") are left alone; the five DATED documents (this file, `open-items.md`,
    `spike-agui.md`, `review-2026-08-05.md`, `plan-agentic-app-maker.md`) are exempt BY NAME
    with the reason in the test, and each now carries a header saying which contract version
    its counts belong to — rewriting a dated document's arithmetic would make it lie about
    its own date. Proved by breaking it: `README.md` set to "66 operations" fails the guard.

38. Make the suite clean under full shuffle — two pre-existing failures, both reproducing in
    isolation: a listener in `parity.test.ts` that misattributes later requests, and one
    streaming test in `ChatPage.test.tsx`. File-order shuffle alone is already green.

---

Not on the list, deliberately: a hosted multi-tenant platform (parked indefinitely); sidebar
row virtualisation, the three `AUTH_E2E` skips, the `"TODO:"` string the readiness script
emits for adopters, and the unimplemented-operations registry in the parity test — all four
are correct as they are, do not "fix" them.
