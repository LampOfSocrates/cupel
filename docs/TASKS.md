# Cupel — TODO

Open work only. Numbers are stable so `git log` stays searchable; gaps are things
that shipped or were dropped, and git has them.

Invariants (never break): versions/judgments/snapshots append-only · generator writes only
via public API · /me always called · no AUTH_MODE branches · one config artifact.

---

12. Memory panel — view/edit/clear per tree, compaction as a visible QUEUED TASK, not a
    spinner. The last contracted but unbuilt family; leaving it stubbed makes the contract a
    lie to anyone running `cupel-ready`. Four operations, all declared and none served:
    GET/PUT/DELETE `/agenttrees/{tree}/memory` and POST `…/memory/compact`. Memory is the one
    store exempt from append-only — PUT overwrites, DELETE clears.

13. Persistence guidance — `docs/persistence.md` (Postgres spine, object storage for span
    payloads, ClickHouse/OTLP for span metadata, a durable workflow engine for the queue, Redis
    for SSE fan-out), the "do NOT copy the physical layer" header on the db module, and a
    schema-wide owner column. The generated README must link it, which is why it cannot be
    linked before it exists.

16. Turn on demo persistence — the code shipped but the hosted demo still runs
    `CUPEL_STORAGE=local`, so a restart wipes it. Needs an R2/S3 bucket + scoped token, then
    `CUPEL_STORAGE=s3` plus `CUPEL_S3_BUCKET` / `_ENDPOINT` / `_ACCESS_KEY_ID` /
    `_SECRET_ACCESS_KEY` (optional `_PATH`, `_REGION=auto`). **That path has never once
    executed** — the first real deploy IS the test, and `/healthz` `storage.mode` reports
    whether it degraded back to local. Blocked on your credentials. Item 36 waits on it.

17. UX phase planning session — with you. Desktop-first, organised around the wedge persona's
    first ten minutes, ending with THEIR agent answering in a real UI rather than our demo
    with fake data. Inputs: lead with "bring your own agent" and `cupel-ready --init` as the
    on-ramp; there is no tree switcher, so cross-tree results cannot be linked; and the
    coverage gaps — no visual regression testing at all, e2e never runs the built bundle
    Render serves, chromium only, portrait filmed nowhere, BYOK live mode / s3 restore / a11y
    / SSE-drop / 5xx all untested.

23. Generator control API + drip-rate settings — un-greys the placeholders at
    `SettingsPage.tsx:253,258,264`, which a test at `SettingsPage.test.tsx:173` pins as
    deliberate, so this item has to edit that test too. POST `/admin/generator` and GET
    `/admin/generator/status` are the only two operations keeping the mock's `admin` family
    at 6/8 partial. The engine already exists — `mock/generator.py` has `seed()` and `drip()`,
    driven from the CLI by `npm run simulate` — so the work is a lifecycle owner for a
    long-running task inside uvicorn, not new generation logic, and it must keep writing
    through the public API.

24. k8s manifests + a Helm post-upgrade Playwright job that blocks a bad release. Artifacts
    and local validation only — no live cluster.

26. Agents as Code — GitHub connect, instruction changes as PR diffs, merge promotes the
    version live. No free tool does this.

36. `docs/deployment.md` describes the R2 bucket and s3 restore as if configured and observed.
    None of it has ever run (item 16). Mark it untested until it has.
