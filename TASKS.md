# Loom TASKS — worked by the auto-runner, one task per fresh session
# Protocol per task (enforced by hooks + runner): implement → tests green → commit "P{phase}-T{id}: <summary>" → stop.
# Runner picks the first unchecked box. Do not start a task whose deps are unchecked.

## Phase 1 — serial spine
- [x] P1-T00 OpenAPI contract draft (all Phase-1 endpoints, /agenttrees/{tree}, envelope on turns, chat stream true/false)
- [x] P1-T18b Mock server core (FastAPI, SSE chat+tasks, SQLite, task lifecycle, both chat modes)  [deps: T00]
- [x] P1-T01 App shell + sidebar conversation list  [deps: T18b]

## Phase 1 — track A (chat)
- [x] P1-T02 Chat page SSE streaming  [deps: T01]
- [x] P1-T03 Turn actions (feedback/copy)  [deps: T02]
- [x] P1-T04 Composer + uploads  [deps: T02]
- [x] P1-T05 Chat settings submenu  [deps: T02]

## Phase 1 — track B (runs/agents)
- [x] P1-T09 Shared components (Picker/RunConfig/Comparison/Queue-panel/RunsList)  [deps: T01]
- [x] P1-T10 Agent tree view  [deps: T09]
- [x] P1-T10b Instruction editor (versions/diff/snapshots)  [deps: T09]
- [x] P1-T11a Context envelope capture + frozen replay default  [deps: T18b]
- [ ] P1-T11 Runs 3-step flow  [deps: T09, T11a]
- [ ] P1-T13 Turn forks + Open in Chat  [deps: T11, T02]
- [ ] P1-T14 Fork comparison pivot  [deps: T13]
- [ ] P1-T12b Basic eval (judge toggle, judgments, drawer)  [deps: T11]
- [ ] P1-T20b Test in Runs (snapshot, last-selection)  [deps: T10b, T11]

## Phase 1 — track C (platform)
- [ ] P1-T08 Task queue (SSE progress, cancel, retry)  [deps: T18b, T01]
- [ ] P1-T18 Generator seed + basic drip  [deps: T18b]
- [ ] P1-T16 Trace view  [deps: T18b, T02]
- [ ] P1-T18c Live-LLM BYOK mode (OpenRouter passthrough in mock; X-LLM-Key/X-LLM-Model headers; key never persisted or logged; max_tokens cap + rate limit; see docs/deployment.md)  [deps: T18b]

## Phase 1 — close
- [ ] P1-T15 Tune/Evaluate presets  [deps: T11]
- [ ] P1-TDEPLOY Render demo deploy (Dockerfile: FastAPI serves built frontend + API; deterministic re-seed on boot; shared-token gate; see docs/deployment.md)  [deps: T18b, T01, T02]
- [ ] P1-TE2E Smoke e2e + walk the Phase-1 DoD  [deps: all above]

## Phase 2 (order per loom-phases.md build order — expand when Phase 1 is green)
- [ ] P2-CONFIG agentic.config.ts + single API client
- [ ] P2-T17 Backend switcher · P2-READY readiness script · P2-T07 auth · P2-T07b/07c admin+permissions
- [ ] P2-T12/T12a eval workbench + inspector/casebooks · P2-CTX context policy+tools playback
- [ ] P2-T20 repo/PR · P2-T19b k8s e2e harness · P2-MSW parity · P2-GEN generator controls · P2-MEM memory plumbing
