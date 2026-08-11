# Cupel
Evidence rules, always: quote the spec lines you are working from, cite file:line for any
claim about existing code, check lockfile versions before using an API. Flag ambiguity
instead of guessing.

**Cite code and the contract by file:line — never a prose doc.** `openapi.yaml:NN` and
`src/…:NN` point at artifacts a reader can verify and a test can guard. A line number into
a Markdown document rots the moment a paragraph moves: 226 such citations had to be
re-pointed across 83 files after one doc lost five lines. When a doc explains WHY, quote
the sentence into the comment and drop the pointer — the quote survives, the number doesn't.

Read before any work: **docs/feature-spec.md** — the what; sketches/clean/ = target
density, sketches/ = API wiring. docs/TASKS.md is the work queue, and its numbering is the
commit convention (`N: <summary>`).

Status: feature build-out COMPLETE — FULL STOP. Work is user-directed; build what the
current task asks for and nothing beyond it.
Invariants (never break): versions/judgments/snapshots append-only ·
generator writes only via public API · /me always called ·
no AUTH_MODE branches · one config artifact.

## Frontend conventions (set in P1-T01)
- Stack: Vite + React 19 + TypeScript; component library = **Mantine** (@mantine/core 9) — use it for all controls, no hand-rolled forms; routing = react-router 8 (`import from "react-router"`).
- Backend targets: agentic.config.ts at repo root (THE one config artifact); active target resolved device-locally by src/api/target.ts; ALL calls go through src/api/client.ts (typed, throws ApiError{status,code,message}). No fetch/hosts elsewhere (guarded by tests/no-hardcoded-hosts.test.js).
- Dev loop: `npm start` (scripts/dev.mjs) boots UI + the bundled demo backend per agentic.config.ts `localMock {enabled, port, dbPath}` and banners the backend + its storage; `npm run dev` / `npm run mock` stay for separate terminals.
- Types mirror openapi.yaml schemas in src/api/types.ts (cite schema line refs).
- Layout: src/shell/ (frame + sidebar), src/pages/ (one per route), src/lib/ (pure helpers).
- Tests: vitest projects — "contract" (node, tests/) + "ui" (jsdom, colocated src/**/*.test.tsx, setup src/test/setup.ts). MSW handlers in src/test/msw/handlers.ts — extend them per task, they mirror the contract; unhandled request = error. **src/test/msw/parity.test.ts enforces that**: every api.* method must be exercised there, every handler route must be a contract operation, and every response is validated against openapi.yaml (required keys, types, enums, no invented fields). Add a client method → add an exercise, or it fails.
- E2e: Playwright (e2e/, `npm run e2e` = 13 journeys × both auth modes; `e2e:smoke` / `e2e:auth` are subsets) — opt-in, NOT part of `npm test`; boots the real mock + vite via webServer on a scratch SQLite (CUPEL_MOCK_DB), never the dev DB, seeded from the deterministic generator (seed 42). One spec per journey (`e2e/jNN-*.spec.ts`), each asserting the sketch's endpoint tags via `e2e/helpers/api.ts`. `npm run e2e:record` (P2-RECORD) films the journeys under the `record` project into Playwright's own HTML report — every npm script pins `--project=chromium` so the record project never joins a normal run. See README "End-to-end suite".
