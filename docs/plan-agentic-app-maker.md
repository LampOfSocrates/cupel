# Plan — `agentic-app-maker` (Phase 3, PLAN ONLY — do not build yet)

**SUPERSEDED.** The generator half was replaced by `docs/plan-adopter-onboarding.md`
and shipped as `npm run create` (TASKS.md item 11, 2026-08-10) — the command, its
flags and its questions are all different from what is described here. Kept as the
record of what was superseded, so its counts (69 operations, contract v0.3.0) and its
`npx` invocations of an unpublished package are left exactly as written;
tests/doc-counts.test.js exempts this file by name for that reason.

User decision 2026-08-06. Goal, in their words: at the end of Phase 3 someone should be
able to check out this repo and run

```
cupel create-agentic-app|ui|backend --name myapp --same-repo \
      --gap-as-mock server --mybackend XXXX/docs
```

…and get one or two folders containing all the code they need, plus printed next steps
covering (1) how to test it, (2) how to run it, (3) how to change their backend.
**With no `--mybackend`, the bundled mock does everything.** All of it lives in
`cli/agentic-app-maker/`.

This document is the plan. **No implementation until the UX phase closes and the user
says go.**

---

## 1. How this changes earlier decisions

Two prior decisions are superseded — recorded here so the change is deliberate, not drift:

| Earlier decision | Now |
|---|---|
| "create-agentic-app scaffolder parked indefinitely" (2026-08-05) | **Un-parked** as the Phase-3 deliverable, in the reduced form below (no feature-bundle stripping unless §7-Q3 says otherwise) |
| P4-HYBRID "hybrid backend fill" = pro tier | **Overlaps `--gap-as-mock`.** Recommendation: the *static* generation-time gap fill becomes free Phase 3 (it is what makes adoption possible at all); the *runtime* per-request routing with "served by mock" badges can stay Phase 4, or be dropped as redundant. **Needs a decision (§7-Q1).** |

Unchanged: no hosted multi-tenant platform.

## 2. Command surface

One binary, three generation targets:

```
cupel create-agentic-app   # UI + backend (the default, "give me everything")
cupel create-ui            # UI only — for people who already have a backend
cupel create-backend       # backend only — for people who like our UI but need a server
```

Flags:

| Flag | Meaning | Default |
|---|---|---|
| `--name <myapp>` | Product name. Drives folder names, `package.json` name, `product.name`/`product.label` in the generated config, page title, banner text. | required |
| `--same-repo` | Generate **into this checkout** instead of a sibling folder. | off → creates `../<name>/` |
| `--mybackend <url-or-path>` | The adopter's OpenAPI document (URL, or a local file). Drives base URL, prefix remap, auth scheme, and the gap report. | none → mock serves everything |
| `--gap-as-mock <mode>` | What to do about endpoints their backend doesn't implement. `server` = generate a compose setup where the bundled mock serves the missing families. `off` = leave the gaps failing. `report` = just print them. | `server` when `--mybackend` is given, else n/a |
| `--dry-run` | Print the file plan and next steps; write nothing. | off |
| `--force` | Overwrite a non-empty target. | off (refuse) |

`--same-repo` semantics matter and must be spelled out in the help text: it **edits this
checkout in place** (config, product name, README quickstart) rather than copying. That's
the "I cloned Cupel and I'm making it mine" path. Without it, the CLI produces a fresh
project the adopter can `git init` themselves — which is the "I want my own repo" path.

## 3. What gets generated

### `create-ui` → `<name>/ui/` (or in place with `--same-repo`)

- The React app (`src/`, `index.html`, vite/tsconfig/vitest config, `package.json` renamed).
- **`agentic.config.ts`, prefilled** — this is the whole point. Targets derived from
  `--mybackend` via the existing `cupel-ready --init` logic (base URL, prefix remap,
  `requiresToken` from the detected security scheme), `product.name`/`label` from `--name`,
  `localMock.enabled` set to `false` when a backend was supplied and `true` when it wasn't.
- The test suite, so a generated project is green on day one (`npm test` must pass in the
  generated folder — that is an acceptance criterion, see §6).
- A generated `README.md` whose quickstart is the *actual* commands for *their* setup.

### `create-backend` → `<name>/backend/`

A **FastAPI project scaffold implementing the contract**, seeded from the reference mock
but restructured for someone to own:

- Routers grouped by resource (chat, conversations, agents, runs, tasks, eval, admin),
  every operation in `openapi.yaml` present as a typed stub returning `501 Not Implemented`
  with the spec citation in the docstring — so "what's left to do" is greppable.
- Pydantic models generated from the contract schemas.
- The persistence layer **not** copied verbatim from `mock/db.py` (see
  `docs/review-2026-08-05.md` D2 — it is a good shape reference and a bad physical one).
  Ship a Postgres-oriented skeleton with real indexes, transactions and a tenant column,
  and link the persistence guidance.
- `cupel-ready` wired as the project's own conformance test, so their CI answers
  "how much of the contract do I implement?" from the first commit.

### `create-agentic-app` → both, plus the glue

- `docker-compose.yml` (UI, their backend if local, and the gap-mock when
  `--gap-as-mock server`).
- `.env.example` naming every variable the generated setup reads.

### With `--gap-as-mock server`

Run `cupel-ready` against `--mybackend`, take the missing set, and generate a **gap mock**:
the bundled mock configured to serve only the missing *feature families* (all eval
endpoints, or all task endpoints, …) with the adopter's backend serving the rest. Family
granularity, never per-endpoint — the two stores don't share data, so mixing at endpoint
level produces nonsense joins. The generated README must say plainly that gap-served
features are **demo-quality placeholders over separate storage**, not functional against
their data.

## 4. The printed next steps (the deliverable the user actually asked for)

After writing files, print exactly three numbered sections, each with runnable commands
for *this* adopter's configuration — not generic docs:

```
myapp is ready.

1) Test it
   cd myapp/ui && npm install && npm test        # 350+ unit tests
   cd myapp/backend && pip install -r requirements.txt && pytest
   npx cupel-ready https://api.mycorp.com/openapi.json    # contract conformance: 44/69

2) Run it
   docker compose up            # UI :5173 · your backend :8000 · gap mock :4010
   # or, without Docker:
   cd myapp/ui && npm start

3) Change your backend
   Your backend implements 44 of 69 contract operations.
   Missing families (currently served by the gap mock): eval workbench, memory, casebooks.
   - Implement an endpoint → delete its stub in backend/routers/<family>.py
   - Re-check anytime:  npx cupel-ready <your-openapi>
   - When a family is complete, drop it from gapAsMock in agentic.config.ts
   Contract reference: openapi.yaml (v0.3.0) · persistence guidance: docs/persistence.md
```

With no `--mybackend`, section 3 instead explains how to *start* a backend: point
`--mybackend` at it later, or run `create-backend` to get the scaffold.

## 5. Where the code lives

```
cli/agentic-app-maker/
  index.mjs            # arg parsing, orchestration, the next-steps printer
  targets/ui.mjs       # UI generation
  targets/backend.mjs  # backend scaffold generation
  gap.mjs              # gap report → family mapping → gap-mock config
  config.mjs           # agentic.config.ts emission (shares logic with cupel-ready --init)
  templates/           # backend routers/models templates, README/compose templates
  __tests__/           # golden-file tests
```

Plain Node ESM, no new runtime dependencies, matching `scripts/cupel-ready.mjs`. Exposed
via `package.json` `bin`: `cupel` → `cli/agentic-app-maker/index.mjs`, so
`npx cupel create-agentic-app …` works from a checkout. **Reuse, don't fork:** the
comparator (`scripts/conformance.mjs`) and the `--init` derivation logic already exist and
must be shared, not copy-pasted.

## 6. Acceptance criteria (what "done" means)

1. `cupel create-agentic-app --name myapp` with **no** backend produces a project that
   boots on the bundled mock and whose own test suites pass, unmodified.
2. `--mybackend <a real OpenAPI>` produces a config that points at it, with any prefix
   remap detected, and `cupel-ready` in the generated project reports the same numbers the
   CLI printed.
3. `--gap-as-mock server` against a deliberately partial backend fixture yields a running
   setup where implemented families hit the real backend and missing families hit the mock
   — proven by an e2e test, not by inspection.
4. `--same-repo` leaves this checkout runnable and its tests green.
5. `--dry-run` output matches what a real run writes (golden test).
6. The generated project contains **no** references to Cupel's internal task IDs, phase
   plan, or `TASKS.md`.

## 7. Open decisions (need the user before building)

- **Q1. Does `--gap-as-mock` make P4-HYBRID redundant?** Recommendation: yes — implement
  static family-level gap filling here in Phase 3, and delete P4-HYBRID rather than keep a
  pro-tier variant that differs only by badges.
- **Q2. What language is `create-backend`?** Recommendation: FastAPI/Python first, since
  the reference mock is already FastAPI and can seed the templates. A TypeScript/Express
  target is a later addition, not a launch requirement.
- **Q3. Feature trimming (`--features no-evaluate`) from the original Phase-3 spec — in or
  out?** Recommendation: **out**. Removing routes, menus and code bundles cleanly is the
  most fragile part of the original design, and an adopter can delete a route folder
  themselves. Revisit only if someone actually asks.
- **Q4. Does `--same-repo` rename the git remote / reinitialise history?** Recommendation:
  no — touch no git state, print a suggestion instead. Rewriting someone's VCS is not a
  scaffolder's job.
- **Q5. Should the generated backend include a working reference implementation of the
  simple families (chat, conversations) rather than only stubs?** Recommendation: yes for
  chat + conversations (it makes the thing runnable immediately and demonstrates the SSE
  contract, which is the hardest part to get right from prose); stubs elsewhere.

## 8. Task breakdown (for TASKS.md when Phase 3 starts — NOT before)

- **P3-CLI-A** — CLI skeleton in `cli/agentic-app-maker/`: arg parsing, `--dry-run`,
  the file-plan model, the next-steps printer, golden tests.
- **P3-CLI-B** — `create-ui` target: project emission + prefilled `agentic.config.ts`
  (sharing `--init` logic), generated README, "generated project is green" test.
- **P3-CLI-C** — `create-backend` target: contract-driven FastAPI scaffold, Postgres-shaped
  persistence skeleton, conformance test wiring.
- **P3-CLI-D** — `--gap-as-mock server`: family mapping from the gap report, gap-mock
  config, compose glue, the partial-backend e2e proof.
- **P3-CLI-E** — `--same-repo` in-place mode + docs, and the acceptance walk (§6) end to end.

Dependencies: all of Phase 2 (the CLI consumes `cupel-ready`, the config artifact, and the
mock's storage modes), and it should follow the UX phase so the generated UI is the polished
one.
