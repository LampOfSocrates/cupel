# Loom
Read these before any work, in order:
1. react-migration.md — evidence rules: quote spec lines, cite file:line, check lockfiles
2. loom-phases.md — we build phase by phase; NEVER build ahead of the current phase
3. feature-spec.md — the what; sketches/clean/ = target density, sketches/ = API wiring

Current phase: 1. Current task: P1-T02 Chat page SSE streaming (contract = openapi.yaml v0.2.0).
Invariants (never break): versions/judgments/snapshots append-only ·
generator writes only via public API · /me always called ·
no AUTH_MODE branches · one config artifact.

## Frontend conventions (set in P1-T01)
- Stack: Vite + React 19 + TypeScript; component library = **Mantine** (@mantine/core 9) — use it for all controls, no hand-rolled forms; routing = react-router 8 (`import from "react-router"`).
- Backend URL: hand-edited constant in src/api/base.ts; ALL calls go through src/api/client.ts (typed, throws ApiError{status,code,message}). No fetch/hosts elsewhere.
- Types mirror openapi.yaml schemas in src/api/types.ts (cite schema line refs).
- Layout: src/shell/ (frame + sidebar), src/pages/ (one per route), src/lib/ (pure helpers).
- Tests: vitest projects — "contract" (node, tests/) + "ui" (jsdom, colocated src/**/*.test.tsx, setup src/test/setup.ts). MSW handlers in src/test/msw/handlers.ts — extend them per task, they mirror the contract; unhandled request = error.
