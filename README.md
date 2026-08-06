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
| `npm run e2e:smoke` | Playwright smoke (boots its own mock on a scratch DB) |
| `npm run ready -- <openapi>` | check a backend against the contract |

## Deployment

The hosted demo runs the same mock as its whole backend, serving the built
bundle from the same origin — see [docs/deployment.md](docs/deployment.md).
