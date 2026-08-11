# Cupel
Read these before any work, in order:
1. docs/cupel-phases.md — we build phase by phase; NEVER build ahead of the current phase
2. docs/feature-spec.md — the what; sketches/clean/ = target density, sketches/ = API wiring

Evidence rules: quote spec lines, cite file:line, check lockfiles.

Current phase: 2. Current task: Phase 2 COMPLETE — FULL STOP. Next: UX polish phase, planned with the user (see docs/TASKS.md).
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
