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
   Stage C DONE 2026-08-09 — **`Judgment` is a polymorphic subject + scorer.** The four
   mutually-exclusive nullable keys and the `type` enum are GONE, not aliased:
   `{id, subject{kind,id}, scorer{kind,ref,version,model}, evaluation_id?, score, reasoning?,
   created_at}`. `subject.kind` is `case|turn` and `scorer.kind` is `llm|human` — declared
   tight, only what is produced today; `check` and a pairwise `evaluation` subject are
   additive enum values, which is the whole point of the reshape. `evaluation_id` stays a
   top-level SCOPE (not a subject) because one case scored inside two evaluations must not
   collide — `?evaluation_id=`, the summary and `Result.latest_score` all key on the pair.
   A thumb's scorer is a bare `{kind: human}` with ref/version/model null; no rubric is
   invented for a person. `EvaluationScoreSummary.rubrics` became `.scorers`, grouping by
   scorer identity through the same `Scorer` schema, so a deterministic check aggregates
   with no further bump. `GET /eval/judgments` swaps `case_id`/`turn_id`/`rubric_id` for
   `subject_kind`/`subject_id`/`scorer_ref`; `conversation_id` survives as a query filter
   and a SQLite index only, never a wire field. SQLite rebuilt by a fifth presence-guarded
   migration (`_migrate_judgment_subject_scorer`, ordered after the run→evaluation rename
   it depends on), covered by its own pytest. Found during stage C, **not fixed**:
   **(vii)** stage B's wrinkle is UNCHANGED — a judgment against a set version can still
   name a case that is not a member of that version, because judging resolves reference
   items without rewriting membership. Nothing about the reshape makes it better or worse;
   the fix is a `set_id`/`set_version` scope pair beside `evaluation_id`, and it needs
   eval-set design, not judgment design.
   Stage D DONE 2026-08-09 — **`Evaluation.status` is derived; Task is the single writer.**
   The field STAYS on the wire (`readOnly: true` now) — removing it would push a join onto
   every caller. **There was no column to drop:** `evaluations` has never carried `status`,
   in this schema or its pre-rename `runs` shape (whole git history checked), so the promised
   sixth migration has no referent and was not written; `mock/db.py` says so at the table
   instead. What changed is the read: `engine.evaluation_status()` resolves it, and a
   **partially-failed evaluation now reads `failed`** — the batch Task stays `done` ("failed
   children don't kill the batch", pinned by `e2e/j06-queue.spec.ts:87`), but a grid missing
   a cell is not `done`, and the next move is retry-failed. A **pruned/unknown task** falls
   back to the evaluation's own cells: all `done` → `done`, anything else → `failed`; never
   `queued`/`running`. Cross-tree set replays share one task, so the partial-failure check
   counts only failed units carrying this evaluation's id. `retry_failed` no longer writes
   `failed` on the parent — that was the second aggregate, and it made one batch read `done`
   on the first pass and `failed` after a retry that changed nothing. Consequence to watch:
   `EvaluationPage.tsx:200,:452` gate auto-judge and the Judge button on `status === "done"`,
   so a partial failure must be retried before it can be judged — the right default, but a
   behaviour change, not just a serialiser change.
   Stage E DONE 2026-08-09 — **the contract declares its families, and Health reports them.**
   Verified from the contract, not from a doc: **66 operations across 48 paths, in 14
   families**, every operation carrying exactly one tag and none resisting classification.
   The **"ten → nine" in item 1(c) above is wrong** and the doc it came from was wrong twice:
   it named `instructions`, which has never been a tag separate from `agents`, and omitted
   `memory`, which item 12 itself calls a family. The real move was **15 → 14** (the
   `casebooks` tag). Mechanism: the top-level **`tags`**, each given a description — chosen
   over an `x-` extension or a schema enum because the tag is already written on every
   operation, so the classification lives with the thing it classifies and cannot drift from
   it; a separate list would need a second edit per new operation and be silently wrong until
   noticed. Four contract tests make it a partition (exactly one tag per operation, declared,
   used, described). `Health` gains `contract_version` + `capabilities` (bucket-C **C11**,
   done early because it is additive and is the natural home for the family names) with a new
   `Capability` schema, `{status: full|partial|none, implemented?, operations?, missing?}`.
   `scripts/conformance.mjs` grew `families()`/`familyReport()` and every report is now
   grouped by family; **no second list was deleted because none existed** — the scripts never
   carried one, the only family lists were prose in `docs/plan-adopter-onboarding.md:25`
   (now removed and replaced by a pointer to the contract) and TASKS.md item 1(c). The mock
   declares its own coverage in `mock/capabilities.py`: **58/66 — `admin` partial (6/8, the
   generator control API), `memory` and `settings` none, the other eleven full.** It is a
   cached projection, not a second truth: `test_ready.py` recomputes the whole table from the
   contract through `cupel-ready --json` and fails on any drift, which is cheaper than
   bundling `openapi.yaml` plus a YAML parser into the runtime image for a value that only
   moves when the contract does.
   Stage F (payload cluster) DONE 2026-08-10 — **one collection shape, transcripts off the
   conversation, and a conditional grid.** F1 `4bec493`, F2 `80d91b5`, F3 (this commit).
   **The shape is OFFSET `{items, page, page_size, total}`, not the cursors the review asked
   for**, and the reason is `total`: every consuming surface here offers "load more" or a page
   jump, and both need a count a cursor page does not carry — "showing 20 of 143" is the whole
   difference between paging and silently truncating. `LIMIT`/`OFFSET` also ports to whatever
   store an adopter implements this contract over, where a keyset cursor is per-database work
   with an encoding each implementor would invent. Newly paged: users, evaluations, tasks
   (its bare `limit` is gone), rubrics, eval sets, judgments. **Four bare arrays stay**, each
   saying why at its own response — `/models` and `…/endpoints` (backend-configured
   enumerations a dropdown needs whole), `/agenttrees` (the scope selector every path hangs
   off) and `…/agents` (a hierarchy: a page of it orphans nodes). **The last two are a
   refusal, not an omission**: paging them needs a searchable tree picker and a lazy-expand
   traversal, which is item 17's work, not a parameter. F2 removed `Conversation.turns`,
   added `turn_count`, and made the transcript the contract's 67th operation
   (`…/conversations/{id}/turns`, family `conversations` 4 → 5) — chronological, so page 1 is
   immutable while a conversation grows, and an omitted `page` means the LAST page, because
   that is where a reader starts; `?turn_ids=` is what keeps the eval-set reference preview
   from becoming a lie. F3 made `Evaluation.rows` a page and `getEvaluation` conditional
   (`ETag` + 304): the body is rows × columns × cells and the page POLLS it, and row paging
   is safe precisely because an evaluation's rows are fixed at creation while only its cells
   change. Found and NOT fixed: **(viii)** cross-conversation batch turn fetch (bucket C10)
   is still absent — `?turn_ids=` narrows within ONE conversation, so the eval-set preview
   still issues one request per referenced conversation.
   Stage F4 DONE 2026-08-10 — **the append-only saves are POSTs to `…/versions`.** All nine
   `put:` operations were classified, not just the three known offenders. FOUR minted a
   version and answered 201 — instructions, eval cases, eval sets, rubrics — and are now
   `POST …/instructions/versions`, `POST /eval/cases/{id}/versions`,
   `POST /eval/sets/{id}/versions`, `POST /eval/rubrics/{id}/versions`. FIVE are genuine
   replacements and STAY `PUT`, each answering 200 with the stored state: `/settings`,
   `/admin/users/{id}/permissions`, `…/last-selection`, `/agenttrees/{tree}/memory` (the
   documented mutable exception) and `/admin/users` — a bulk upsert keyed by email, which is
   not a whole-collection replacement but IS idempotent, and idempotence is the property PUT
   promises. The new rule is a contract test rather than prose: no `put:` may declare a 201,
   and the list of five is pinned. Counts: 67 operations unchanged, every family unchanged
   (so `mock/capabilities.py` did not move), paths 49 → 52. Stage B's split is preserved —
   set metadata stays `PATCH /eval/sets/{id}` and appends nothing. `feature-spec.md` took
   seven in-place substitutions, no line-count change. Found and NOT fixed: **(ix)** there is
   still no GET on any `…/versions` collection, so version history stays unreadable (bucket-C
   C5); the sub-collection these POSTs created is exactly where that GET belongs.
   Stage F6 DONE 2026-08-10 — **the soft delete is visible.** Every delete in the store was
   classified first, and there are exactly TWO resource deletes, deliberately different:
   a conversation is SOFT (four things point into it — a fork's lineage, an eval-set
   reference item, an eval case's source, a judgment's subject), an eval SET is HARD and
   right to be (a set is a named selection; nothing on the wire references a set id, and
   the cases/judgments/evaluations it pointed at all survive). `DELETE …/memory` is a
   content reset, `DELETE /tasks/{id}` is a cancel, and there is no user delete at all.
   On the wire that became ONE required readOnly field, `Conversation.deleted`: the
   tombstone READS (GET and `…/turns` both keep answering — that is what the kept row is
   for), leaves every listing, and refuses new work with 409 `conversation_deleted`;
   DELETE is idempotent. A boolean, not `deleted_at` — nothing has ever recorded WHEN, so
   a timestamp would be invented for old rows, and a null meaning both "live" and
   "deleted, time unknown" is worse than no field. **No migration: the `deleted` column
   has always existed**, only the serialiser and the read path changed. Deliberately left
   out: **restore** (not an endpoint — a place to find tombstones, a rule for their forks,
   an answer for restoring into a disabled tree; that is item 17's UX) and
   **`?include_deleted=`** (with no restore and no purge nothing could act on the list, and
   every real caller arrives by reference, i.e. by id). The UI half was the actual bug:
   `ChatPage` and `ForkComparePage` inferred "parent deleted" from a 404 — the same 404 an
   unknown id and an unpermitted tree answer — so the banner was a guess. Both read the
   flag now; a tombstone opens read-only with a banner instead of a composer that would
   409 on every send; and fork compare's baseline card SHOWS the original turn where it
   used to say "unavailable". Journey 4 pins the live behaviour end to end.
   Stage F7 DONE 2026-08-10 — **an error is `{code, message, request_id, details?}`, and the
   contract declares the statuses the implementations actually return.** `details[]` is
   `ErrorDetail {field?, row?, message}` — deliberately the SAME schema the spreadsheet
   import already returned per row, whose private near-copy (`{row, column?, message}`) is
   gone; `column` became `field`, which also carries a dotted body path (`items[2].kind`) or
   a query-parameter name. **RFC 9457 was considered and DECLINED**: its `type` URI is the
   point of the format and there is no namespace here to dereference, so every adopter would
   invent a private one; `status`/`instance` restate the status line and the path; its
   extension members are shapeless, so it would still give a client nothing typed to point
   at a field with; and it would put a second media type on every error response for no
   gain. `request_id` is **honoured from an inbound `X-Request-Id`** (opaque, <=128 chars —
   anything else is dropped for a fresh one) and generated otherwise, because an adopter
   behind a gateway already stamped a trace id and a second one would be unjoinable to their
   logs. It rides the `X-Request-Id` header on EVERY response, 2xx included, via a pure-ASGI
   middleware registered OUTERMOST so even a gate's 401 is traceable; it joined `ETag` in
   `expose_headers` or a browser could not read it. `ApiError` gained `requestId` +
   `details` (header read FIRST, so a proxy's non-JSON 502 still yields one) and the new
   `ApiErrorNote` renders both. **The status sweep was mechanical** — every mock route
   paired with its contract entry — and found **26 operations short**: 422 now on **38
   operations** (every request body, plus every non-string typed query param, since
   `?page=abc` really is a 422), 409 on the **five** remaining writes a disabled tree
   refuses (the old "six" counted `PATCH …/conversations/{id}`, already declared in F6),
   and 404 + 413 on `POST /eval/cases/import`. 401 was NOT swept — the contract has always
   said it is implied by the top-level security block outside `/me`, `/auth/logout` and
   `/admin/*`; 403s belong to F5. **503 is declared NOWHERE and that is the decision**: no
   implementation produces one, and this contract declares no 5xx at all, so adding 503
   without 500 and 502 would be arbitrary — a server fault is an infrastructure state, not a
   specified outcome, and `Health.capabilities` is where a degraded backend says so. A
   contract test pins the absence. **429 became real**: the BYOK sliding window used to
   answer over-limit with 200 + canned content (a user handed mock text under their own
   key), which it could not avoid because generation happens after the response is
   committed — so the check moved to a non-consuming DOOR (`llm.retry_after()`) on the five
   live-generation operations, answering `429 rate_limited` + `Retry-After` before any turn
   or task exists. Only a request carrying `X-LLM-Key` is limited. Detached replay/judge
   children deliberately keep the canned fallback: there is no request left to fail, and a
   half-finished grid is worse than a noted cell.
   Stage F8 DONE 2026-08-10 — **`?search=` says what it matches.** It was a bare
   `{type: string}` with no description: the contract exposed a filter and never defined it,
   so two conformant backends could disagree on every axis and `cupel-ready` could check
   nothing. Declared from what the reference implementation actually did (probed, not read
   off the SQL): SUBSTRING not tokens, the WHOLE value as one substring so `refund policy`
   never matches "policy for refunds", case-insensitive, matched LITERALLY, over the
   conversation's `title` OR the `content` of any turn in it, ANDed with the other filters,
   narrowing BEFORE paging so `total` is the match count, answering with the CONVERSATION and
   no snippet. **Three things the mock was doing wrong, so the mock changed:** `%` and `_`
   reached SQL `LIKE` unescaped (searching `50%` returned the WHOLE collection, `5_%` matched
   "50%"); case folding was ASCII-only on the column but Unicode on the term, which made
   **every non-ASCII conversation unfindable** — `ÜBER` and `über` both returned nothing —
   fixed by a `ci_lower` SQL function so both sides fold by one rule; and the term was not
   trimmed, so a pasted trailing space matched nothing and `"   "` filtered for three spaces.
   **The drift had already happened here**: MSW searched TITLES ONLY while `mock/main.py`
   searched title or turn content, and nothing caught it because there was no rule to catch
   it against. One clause is declared mainly because it surprises — the default listing is
   roots-only, so a match inside a FORK surfaces only under `?forks_of=`. A contract test
   also pins that this is the contract's ONLY free-text search, so a second one cannot
   appear with semantics of its own.
   Stage F5 DONE 2026-08-10 — **the two failures are split: 404 hides, 403 explains.** The
   contract knew the words `view`/`tune`/`evaluate` and never said which operation needed
   which, so the mock enforced `view` centrally and nothing else — a user with `view` but not
   `tune` pressed Save in the editor and got a write that looked like a backend fault. Every
   one of the **67 operations** now declares `x-requires` — `none` 36 · `view` 14 · `tune` 6 ·
   `evaluate` 3 · `admin` 7 · `inspect` 1 — **on the operation itself**, the same mechanism
   for the same reason as stage E's family tags: a declaration that lives with the thing it
   classifies cannot drift from it. It is an `x-` extension only because OpenAPI 3.0 has no
   native vocabulary — security-requirement SCOPES would be the home, but scopes are
   meaningless for an `http bearer` scheme, and minting an unimplemented oauth2 scheme to
   borrow their syntax would be the bigger lie. **The 404 is untouched**, and a contract test
   now pins that: a `view` operation may never declare a 403, because doing so would confirm
   a tree exists to a caller who is meant to be unable to tell. Four contract tests make it a
   partition (every operation classified; a per-tree permission only on a `{tree}` path and
   every `{tree}` path carrying one; 403 declared by exactly the tune/evaluate/admin/inspect
   set). Enforcement is one new innermost `PermissionGate` over the table in
   `mock/permissions.py` — a cached projection guarded like `mock/capabilities.py`, with a
   pytest that re-reads `openapi.yaml` and fails on drift — and it **runs in both auth modes
   with no branch**: the answer comes from the matrix, and an unverified caller IS the dev
   user, who holds everything. `need_admin`/`need_inspect` were DELETED from the handlers
   rather than left beside it; two enforcement points are two things that can disagree.
   One code (`forbidden`) for role and per-tree refusals alike, because the machine-readable
   half is the declaration, not a second discriminator in the body. UI: a 403 now reads
   "Not permitted" + the server's sentence + the request id, in the instruction editor and
   the evaluation stepper — the two surfaces that can now produce one. **Hiding or disabling
   controls per permission is NOT done and is item 17**: `CompareView` already hides the A/B
   toggle without `tune`, but doing that everywhere needs a real answer for what a viewer's
   editor looks like (read-only? no Save? no editor at all?), which is UX design, not a
   permission check. Found and NOT fixed: **(x)** two global operations touch tree-scoped rows
   without narrowing to permitted trees — `GET /tasks` (unlike `/tasks/stream`, which does)
   and `POST /feedback` (a thumb on a turn in a tree the caller cannot view). Their declared
   requirement (`none`) is truthful; the narrowing is its own change. **(xi)** `POST
   /agenttrees` is `none` and grants its creator NO permission on the tree it just made, so
   the creator immediately cannot see it — a real gap, named rather than guessed at, and
   closing it is a contract decision about who may mint a tree.
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
