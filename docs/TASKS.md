# Cupel — TODO

Open work only. Numbers are stable so `git log` stays searchable; gaps shipped or were
dropped, and git has them.

Invariants (never break): versions/judgments/snapshots append-only · generator writes only
via public API · /me always called · no AUTH_MODE branches · one config artifact.

---

12. Memory panel — view/edit/clear per tree, compaction as a visible QUEUED TASK, not a
    spinner. The last contracted but unbuilt family, so `cupel-ready` reports four declared
    and unserved operations: GET/PUT/DELETE `/agenttrees/{tree}/memory` and POST
    `…/memory/compact`. Memory is the one store exempt from append-only.

13. Persistence guidance — `docs/persistence.md` (Postgres spine, object storage for span
    payloads, ClickHouse/OTLP for span metadata, a durable workflow engine, Redis for SSE
    fan-out), a "do NOT copy the physical layer" header on the db module, and a schema-wide
    owner column. The generated README must link it, so it cannot be linked before it exists.

17. UX phase planning session — with you. Desktop-first, built around the wedge persona's
    first ten minutes, ending with THEIR agent in a real UI rather than our demo's fake data.
    Inputs: "bring your own agent" + `cupel-ready --init` as the on-ramp; no tree switcher, so
    cross-tree results cannot be linked; and the coverage gaps — no visual regression testing,
    e2e never runs the built bundle Render serves, chromium only, portrait filmed nowhere,
    BYOK live mode / a11y / SSE-drop / 5xx untested.

23. Generator control API + drip-rate settings — un-greys `SettingsPage.tsx:253,258,264`,
    which `SettingsPage.test.tsx:173` pins as deliberate, so that test changes too. POST
    `/admin/generator` and GET `/admin/generator/status` are the only operations keeping the
    mock's `admin` family at 6/8. `mock/generator.py` already has `seed()` and `drip()`, so
    the work is a lifecycle owner for a long-running task inside uvicorn, not new generation
    logic, and it must keep writing through the public API.

24. k8s manifests + a Helm post-upgrade Playwright job that blocks a bad release. Artifacts
    and local validation only — no live cluster.
