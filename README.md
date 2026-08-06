# Skein

Half chat app, half agent studio — a React studio for agentic backends, with a
bundled FastAPI demo backend so it runs the moment you clone it.
What it does: [docs/features.md](docs/features.md). How it is built, phase by
phase: [skein-phases.md](skein-phases.md).

## Quickstart (you just checked this out)

```
npm install
npm start          # UI on :5173 + the bundled demo backend on :4010
```

`npm start` prints what it booted and where your data lives:

```
Skein
  UI       http://localhost:5173
  Backend  bundled demo mock · http://localhost:4010
           storage: local · mock/skein-mock.sqlite (local file, this machine only)
```

That backend is the demo mock in `mock/` (FastAPI). It is a real, stateful
backend — chat with SSE streaming, runs, versions, judgments, task queue — and
it keeps **everything in one SQLite file on your machine** (`mock/skein-mock.sqlite`,
git-ignored). Nothing leaves the machine; delete the file and you are back to
the seed. Requirements: Node >= 22.18 (`npm start` reads the TypeScript config
directly) and Python 3.11+ with the mock's deps (`pip install -r mock/requirements.txt`).

That same mock is also what the hosted demo runs, where it has no persistent
disk and replicates its SQLite file to object storage instead
(`SKEIN_STORAGE=s3`, Litestream). You never need that locally — see
[docs/deployment.md](docs/deployment.md) "Storage modes".

Fill the app with data while it runs: `npm run simulate`.

The chat half works on a phone in portrait (the sidebar becomes a burger menu);
the studio half — runs, comparison grids, traces, the instruction editor — is
desktop-first by design.

## Using your own backend

Everything about where the API lives is declared in ONE file,
[`agentic.config.ts`](agentic.config.ts):

1. Add your backend to `targets` (`npx skein-ready <your-openapi> --init`
   writes the block for you — see [docs/readiness.md](docs/readiness.md)).
2. Point `defaultTarget.dev` at it.
3. Set `localMock.enabled: false`.

```
npm start          # UI only — no demo backend
```

```
Skein
  UI       http://localhost:5173
  Backend  your backend · https://api.example.com
           Skein stores nothing locally — your backend holds all persistence
```

With the mock off, **your backend holds all persistence**. Skein keeps no
server-side state of its own; the only things it stores are device-local
browser values (which target is selected, your auth token, a BYOK LLM key).
You can also switch targets live in Settings → Backend without restarting.

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

`npm run e2e` walks the 13 user journeys of the coverage checklist
(`feature-spec.md:205-218`), one spec file per journey, in `e2e/`:

| | journey | spec |
|---|---|---|
| 1 | Shell — nav, presets, search, fork nesting | `j01-shell.spec.ts` |
| 2 | Chat — SSE, feedback, copy, upload, stop | `j02-chat.spec.ts` |
| 3 | Runs — select, configure, queue, grid fills | `j03-runs.spec.ts` |
| 4 | Forks — re-fire at 2 endpoints, continue one | `j04-forks.spec.ts` |
| 5 | Judge — scores stream in, drawer, re-score | `j05-judge.spec.ts` |
| 6 | Queue — progress, cancel cascade, retry-failed | `j06-queue.spec.ts` |
| 7 | Editor — draft, snapshot, new version, Test in Runs | `j07-editor.spec.ts` |
| 8 | Trace — call tree, waterfall, lazy span payload | `j08-trace.spec.ts` |
| 9 | Backend switcher — targets, healthz, banners | `j09-backend.spec.ts` |
| 10 | Permissions — hidden tree, matrix edit takes effect | `j10-permissions.spec.ts` |
| 11 | Tree disable — 409s, cancels, read-only, restore | `j11-tree-disable.spec.ts` |
| 12 | Auth — login, 401 redirect, deep link, logout | `j12-auth.spec.ts` |
| 13 | Authoring — eval workbench + inspector → casebook → eval set | `j13-authoring.spec.ts` |

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
(~5MB of video, ~67MB of report including traces). The full product version of
this — a journeys.yaml contract, cursor rendering, chapters, a standalone CLI,
hosted runs — is Phase 4 "Reels", not this.

## Deployment

The hosted demo runs the same mock as its whole backend, serving the built
bundle from the same origin — see [docs/deployment.md](docs/deployment.md).
