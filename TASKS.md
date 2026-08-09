# Cupel — TODO

One list. Top to bottom. Numbered 1..N.

**If an item starts with DECIDE, it needs you, not a runner.** Everything else is work.
Commit as `N: <summary>`. Detail and evidence live in `docs/open-items.md`.

Invariants (never break): versions/judgments/snapshots append-only · generator writes only
via public API · /me always called · no AUTH_MODE branches · one config artifact.

Done this session (12 commits on `evaluations-rename`): the "Runs" concept is gone from the
UI, routes, e2e and docs; the sidebar is two doors (Chat + Evaluate); a real editor data-loss
bug is fixed; eslint exists for the first time. 620 tests green, tsc clean, lint clean.
Those items were `#1`–`#11` in the old scheme, and that is how the commits read.
**This list is open work only, renumbered from 1. Old numbers survive only in git.**

---

1. **DECIDE — is the contract plan (item 7) still right?** Three things moved under it: the UI
   rename already shipped, the Node port now comes first, and merging Casebook+EvalSet changes
   which families item 11 asks the adopter about. Cheap to confirm, expensive to get wrong.

2. Two `useAsync` converts — `ByokSection.tsx:67`, `CompareView.tsx:132`. The other five
   unconverted sites are deliberate; leave them.

3. `RunConfigPanel`: make `initialFocus` and `judgeInitiallyOpen` controlled, then the
   remount-by-key drops to `key={i}`. Both props are dead since the presets were deleted.

4. Fix the spec citations. Deleting the dead preset passages shortened `feature-spec.md` by 5
   lines, so **206 `feature-spec.md:NNN` citations are off** — old 104–293 → −4, old 295–305 →
   −5, old 1–103 unchanged. Also `e2e/j05-judge.spec.ts:7` quotes `'Score this run'`, a button
   string that no longer exists anywhere.

5. Turn `react-hooks/set-state-in-effect` back on — **20 sites across 18 files**, currently
   disabled in `eslint.config.js` with the list inline. Left off, the new lint enforces less
   than it appears to.

6. **Port the mock from Python to Node and delete the Python one.** Multi-week: 69 operations,
   the task queue with parent/child cancellation, SQLite + migrations, the seed-42 generator,
   both auth modes, BYOK, `CUPEL_STORAGE=local|s3`. Also `requirements.txt` deleted, 160 pytest
   cases ported, `Dockerfile`, `render.yaml`, Playwright's webServer, README quickstart.
   Pick a SQLite binding with **no native build step** or the port defeats its own purpose.
   Payoff: Python leaves the quickstart entirely. Our e2e suite is the acceptance test.

7. **Contract v0.4.0.** Fifteen correctness fixes (paging, readable version history,
   idempotency keys, SSE resume, permission semantics, structured errors, batch turn fetch,
   soft delete, search semantics, span retention…) **plus** the domain tighten: `Run`→
   `Evaluation` on the wire, Casebook+EvalSet merged into one noun, `Judgment` gains
   `subject`/`scorer`, `Evaluation.status` derived from its Task. No backward compatibility —
   nothing is published and nobody has adopted it. **After item 6, so the rename is
   type-checked. Before item 14, which closes that window.**

8. **DECIDE — is the generated `<name>-ui/` folder a copy or a dependency?** A copy is
   editable but never receives updates; a dependency is the reverse. A copy is the only thing
   that works while the package is unpublished — but the adopter must be told.

9. **DECIDE — does the command accept a bare agent endpoint, not just a Swagger?** Your wedge
   persona has a framework agent on an HTTP endpoint and **no OpenAPI document at all**.
   Without this, the on-ramp only serves adopters who already have a service.

10. **DECIDE — the four scaffolder questions.** What language for a generated backend
    (recommend Python/FastAPI first) · feature trimming in or out (recommend out) · does
    `--same-repo` touch git state (recommend no) · does the generated backend really implement
    chat + conversations, or only stubs (recommend real for those two).

11. **One command → `<name>-ui/`.** Clone → one command → a folder that `npm run`s a chat +
    studio UI. Checks the tech stack, optionally takes your backend's OpenAPI, asks **per
    family** (~10 questions) with three answers — **mine / mock / hide** — and mocks the rest
    with a "served by mock" badge. Then a staged hook-up guide: chat only (one endpoint, their
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

20. **DECIDE — also ship a thin client-side AG-UI adapter behind a "nothing is persisted"
    banner?** The spike's own answer is no in a first pass. Blocks item 28.

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

28. AG-UI bridge — a server-side adapter so an agent already speaking AG-UI needs no new
    endpoints. ~400–600 LOC on an existing seam. Not a client transport, not a contract change.

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
