# Skein
Read these before any work, in order:
1. react-migration.md — evidence rules: quote spec lines, cite file:line, check lockfiles
2. skein-phases.md — we build phase by phase; NEVER build ahead of the current phase
3. feature-spec.md — the what; sketches/clean/ = target density, sketches/ = API wiring

Current phase: 2. Current task: P2-T12 Eval workbench — cases/sets/rubrics CRUD, hand-crafted references, CSV/XLSX import (sketch 10).
Invariants (never break): versions/judgments/snapshots append-only ·
generator writes only via public API · /me always called ·
no AUTH_MODE branches · one config artifact.

## Frontend conventions (set in P1-T01)
- Stack: Vite + React 19 + TypeScript; component library = **Mantine** (@mantine/core 9) — use it for all controls, no hand-rolled forms; routing = react-router 8 (`import from "react-router"`).
- Backend targets: agentic.config.ts at repo root (THE one config artifact); active target resolved device-locally by src/api/target.ts; ALL calls go through src/api/client.ts (typed, throws ApiError{status,code,message}). No fetch/hosts elsewhere (guarded by tests/no-hardcoded-hosts.test.js).
- Dev loop: `npm start` (scripts/dev.mjs) boots UI + the bundled demo backend per agentic.config.ts `localMock {enabled, port, dbPath}` and banners the backend + its storage; `npm run dev` / `npm run mock` stay for separate terminals.
- Types mirror openapi.yaml schemas in src/api/types.ts (cite schema line refs).
- Layout: src/shell/ (frame + sidebar), src/pages/ (one per route), src/lib/ (pure helpers).
- Tests: vitest projects — "contract" (node, tests/) + "ui" (jsdom, colocated src/**/*.test.tsx, setup src/test/setup.ts). MSW handlers in src/test/msw/handlers.ts — extend them per task, they mirror the contract; unhandled request = error.
- E2e: Playwright (e2e/, `npm run e2e:smoke`) — opt-in, NOT part of `npm test`; boots the real mock + vite via webServer on a scratch SQLite (SKEIN_MOCK_DB), never the dev DB.
