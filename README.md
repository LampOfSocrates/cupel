# Cupel — the console for agents you already built

A chat client your users can actually use, and the studio you need to make the
agent better: versioned instructions, replay and compare, an LLM judge, traces
with cost. Self-hosted. Point it at your backend by editing one file.

**[cupel-site.onrender.com](https://cupel-site.onrender.com)** · what it does:
[docs/features.md](docs/features.md) · how it was built, phase by phase:
[cupel-phases.md](cupel-phases.md)

## Why it exists

Chat interfaces talk to *models* and know nothing about your agent. Evaluation
platforms are dashboards for engineers, and your conversations live on someone
else's servers. You end up running both, and neither knows about the other.

| | Chat client | Agent studio | Self-hosted | Free |
|---|---|---|---|---|
| Open WebUI, LibreChat | ✅ | — | ✅ | ✅ |
| LangSmith, Braintrust | — | ✅ | enterprise | — |
| Langfuse | — | ✅ | ✅ | ✅ |
| Dify, Flowise | ✅ | builds agents | ✅ | ✅ |
| **Cupel** | ✅ | ✅ | ✅ | ✅ |

Langfuse is the closest neighbour and a good tool — but it is a dashboard you
send traces to, not a client your users open. Cupel is both, and nothing is held
back behind a paid tier.

### Deliberately not

- **Building your agent.** There are good frameworks for that (ADK, LangGraph,
  Mastra, PydanticAI, CrewAI). This drives the one you have.
- **Hosting your model.** Your keys, your provider, your bill.
- **Taking your data.** There is no cloud to send it to.
- **Holding features back.** No paid tier, no enterprise edition, no seat count.

## Quickstart (you just checked this out)

```
npm install
npm start          # UI on :5173 + the bundled demo backend on :4010
```

`npm start` prints what it booted and where your data lives:

```
Cupel
  UI       http://localhost:5173
  Backend  bundled demo mock · http://localhost:4010
           storage: local · mock/cupel-mock.sqlite (local file, this machine only)
```

That backend is the demo mock in `mock/` (FastAPI). It is a real, stateful
backend — chat with SSE streaming, evaluations, versions, judgments, task queue — and
it keeps **everything in one SQLite file on your machine** (`mock/cupel-mock.sqlite`,
git-ignored). Nothing leaves the machine; delete the file and you are back to
the seed. Requirements: Node >= 22.18 (`npm start` reads the TypeScript config
directly) and Python 3.11+ with the mock's deps (`pip install -r mock/requirements.txt`).

That same mock is also what the hosted demo runs, where it has no persistent
disk and replicates its SQLite file to object storage instead
(`CUPEL_STORAGE=s3`, Litestream). You never need that locally — see
[docs/deployment.md](docs/deployment.md) "Storage modes".

Fill the app with data while it runs: `npm run simulate`.

The chat half works on a phone in portrait (the sidebar becomes a burger menu);
the studio half — evaluations, comparison grids, traces, the instruction editor — is
desktop-first by design.

## Using your own backend

Everything about where the API lives is declared in ONE file,
[`agentic.config.ts`](agentic.config.ts):

1. Add your backend to `targets` (`npx cupel-ready <your-openapi> --init`
   writes the block for you — see [docs/readiness.md](docs/readiness.md)).
2. Point `defaultTarget.dev` at it.
3. Set `localMock.enabled: false`.

```
npm start          # UI only — no demo backend
```

```
Cupel
  UI       http://localhost:5173
  Backend  your backend · https://api.example.com
           Cupel stores nothing locally — your backend holds all persistence
```

With the mock off, **your backend holds all persistence**. Cupel keeps no
server-side state of its own; the only things it stores are device-local
browser values (which target is selected, your auth token, a BYOK LLM key).
You can also switch targets live in Settings → Backend without restarting.

You do not have to implement all of it at once. The contract's 66 operations
are grouped into **families** — its top-level `tags` in
[`openapi.yaml`](openapi.yaml), one per operation: `chat`, `conversations`,
`agents`, `evaluations`, `trace`, `tasks`, `eval`, `memory`, `settings`,
`trees`, `admin`, `auth`, `identity`, `meta`. `cupel-ready` reports
full/partial/none per family, so "implement chat first" is a plan you can
measure, and a backend can *declare* the same thing about itself in
`GET /healthz` (`contract_version` + `capabilities`). Families are also the
unit the project scaffolder will ask about, one question each — your endpoints,
the bundled mock, or hide that part of the UI.

One shape you implement once and reuse: every operation that returns a
collection of user data answers `{items, page, page_size, total}` and takes
`?page`/`?page_size` — offset paging, because `total` is what lets a screen say
"showing 20 of 143" instead of quietly truncating, and because `LIMIT`/`OFFSET`
ports to any store. Four operations deliberately return a bare array and say so
at their own response: the model and endpoint enumerations, the agent-tree list
and the agent hierarchy, all of which a caller needs whole.

## Commands

| | |
|---|---|
| `npm start` | UI + demo backend per `localMock.enabled` (the front door) |
| `npm run dev` | UI only (vite), for a second terminal |
| `npm run mock` | demo backend only (uvicorn on :4010), for a second terminal |
| `npm run simulate` | seed + drip fake traffic into the demo backend |
| `npm test` | vitest (contract + UI) |
| `npm run test:mock` | pytest for the mock |
| `npm run e2e` | full Playwright suite — every journey, both auth modes |
| `npm run e2e:smoke` | the fast Playwright smoke subset only |
| `npm run e2e:auth` | just the `AUTH_MODE=on` journeys |
| `npm run e2e:record` | film the journeys into Playwright's HTML report |
| `npm run ready -- <openapi>` | check a backend against the contract |

## End-to-end suite

`npm run e2e` walks the 13 user journeys of the coverage checklist —
journeys 1–12 at `feature-spec.md:202-213`, journey 13 (authoring) at
`feature-spec.md:99` — one spec file per journey, in `e2e/`:

| | journey | spec |
|---|---|---|
| 1 | Shell — nav, search, fork nesting | `j01-shell.spec.ts` |
| 2 | Chat — SSE, feedback, copy, upload, stop | `j02-chat.spec.ts` |
| 3 | Evaluations — select, configure, queue, grid fills | `j03-evaluations.spec.ts` |
| 4 | Forks — re-fire at 2 endpoints, continue one | `j04-forks.spec.ts` |
| 5 | Judge — scores stream in, drawer, re-score | `j05-judge.spec.ts` |
| 6 | Queue — progress, cancel cascade, retry-failed | `j06-queue.spec.ts` |
| 7 | Editor — draft, snapshot, new version, Test as evaluation | `j07-editor.spec.ts` |
| 8 | Trace — call tree, waterfall, lazy span payload | `j08-trace.spec.ts` |
| 9 | Backend switcher — targets, healthz, banners | `j09-backend.spec.ts` |
| 10 | Permissions — hidden tree, matrix edit takes effect | `j10-permissions.spec.ts` |
| 11 | Tree disable — 409s, cancels, read-only, restore | `j11-tree-disable.spec.ts` |
| 12 | Auth — login, 401 redirect, deep link, logout | `j12-auth.spec.ts` |
| 13 | Authoring — eval workbench + inspector → eval set → replay | `j13-authoring.spec.ts` |

Plus the Phase-1 regression walks (`smoke.spec.ts`, `dod.spec.ts`) and the
portrait shell (`mobile.spec.ts`).

**Both auth modes, two passes** (`scripts/e2e-full.mjs`) — `AUTH_MODE` is the
mock's boot env, so one Playwright run cannot host both:

- pass 1, `AUTH_MODE=off`: everything except the `@auth-on` specs. Off is the
  demo's mode and the one adopters start in.
- pass 2, `AUTH_MODE=on`: only journeys 10–12. The auth-independent journeys are
  not re-run under a token — no component branches on the auth mode, the token
  is attached in one place (`src/api/client.ts`), and journey 12 walks a full
  chat with it attached to cover that seam.

Each spec asserts the **endpoint tags** its sketch documents — not just that the
screen looks right, but that the journey really called
`POST /agenttrees/{tree}/replay` and friends. The recorder is
`e2e/helpers/api.ts` (~90 lines); patterns are written exactly as the sketches
write them, with `{placeholder}` matching one path segment.

Both passes boot their own mock and vite on a scratch SQLite
(`playwright.config.ts`), never the dev DB, and load the deterministic
generator dataset (seed 42) so journeys that need pre-existing data get the
same data every run.

### Watch the journeys — `npm run e2e:record`

`npm run e2e:record` replays the 13 journey specs (not the smoke/DoD/mobile
walks) under Playwright's `record` project — video on, trace on, a 300ms
`slowMo`, and the mock running ~3× slower so replies actually stream on camera.
Each named `test.step` also paints a caption into the page —
`Journey 5 · Step 2/4 — queue: cells and SCORES both stream into the grid` — so
a film narrates itself if it is watched outside the report. The caption sits in
a closed shadow root (`e2e/helpers/hud.ts`, ~40 lines) that no locator can see,
and it paints only under the `record` project: `npm run e2e` is unchanged.

The run leaves Playwright's own HTML report — **that is the review gallery**,
one row per journey with its film, its end screenshot and its step-by-step
trace:

```
npx playwright show-report      # films are in playwright-report/data/*.webm
```

A film is **evidence, not verification**: the assertions decide pass/fail, the
video only shows what happened while they ran. Everything the run writes
(`playwright-report/`, `test-results/`, `blob-report/`) is gitignored.

Filming the whole set takes about 3 minutes and produces ~16 clips of 5–16s
(~5MB of video, ~67MB of report including traces). The productised version of
this idea — a journeys.yaml contract, cursor rendering, chapters, a standalone
CLI, hosted runs — was deliberately moved out to its own project
(`journey-replayer`) so this stays a clean agentic chat + studio app.

## Deployment

The hosted demo runs the same mock as its whole backend, serving the built
bundle from the same origin — see [docs/deployment.md](docs/deployment.md).

## Why "cupel"

A cupel is the shallow bone-ash dish used to assay silver. Molten metal is held
in it under heat: the lead and impurities are absorbed into the dish, and what is
actually valuable stays behind. It seemed like the right name for a tool whose
job is telling you whether the change you just made was worth keeping.
