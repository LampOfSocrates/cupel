# Skein TASKS — worked by the auto-runner, one task per fresh session
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
- [x] P1-T11 Runs 3-step flow  [deps: T09, T11a]
- [x] P1-T13 Turn forks + Open in Chat  [deps: T11, T02]
- [x] P1-T14 Fork comparison pivot  [deps: T13]
- [x] P1-T12b Basic eval (judge toggle, judgments, drawer)  [deps: T11]
- [x] P1-T20b Test in Runs (snapshot, last-selection)  [deps: T10b, T11]

## Phase 1 — track C (platform)
- [x] P1-T08 Task queue (SSE progress, cancel, retry)  [deps: T18b, T01]
- [x] P1-T18 Generator seed + basic drip  [deps: T18b]
- [x] P1-T16 Trace view  [deps: T18b, T02]
- [x] P1-T18c Live-LLM BYOK mode (OpenRouter passthrough in mock; X-LLM-Key/X-LLM-Model headers; key never persisted or logged; max_tokens cap + rate limit; see docs/deployment.md)  [deps: T18b]
- [x] P1-TRENAME Rename Loom → Skein (user decision; landing page updated separately)

## Phase 1 — close
- [x] P1-T15 Tune/Evaluate presets  [deps: T11]
- [x] P1-TEXPORT Editor: download version history to file (free-tier export; no contract change)  [deps: T10b]
- [x] P1-TDEPLOY Render demo deploy (Dockerfile: FastAPI serves built frontend + API; deterministic re-seed on boot; shared-token gate; see docs/deployment.md) (live Render service created from main session)  [deps: T18b, T01, T02]
- [x] P1-TE2E Smoke e2e + walk the Phase-1 DoD  [deps: all above]

## Phase 2 (expanded 2026-08-05, Phase 1 green; order per skein-phases.md build order)
- [x] P2-CONFIG agentic.config.ts (one config artifact) + API client refactor onto it  [deps: Phase 1]
- [x] P2-T17 Backend switcher UI — Settings → Backend, sketch 09 (targets, healthz check, mock options)  [deps: CONFIG]
- [x] P2-T00 Contract v0.3.0 — extend openapi.yaml: auth, admin users/permissions/tree-toggle, eval workbench CRUD+import, generator control, memory (NO repo endpoints — pro tier); update contract tests  [deps: CONFIG]
- [x] P2-READY skein-ready readiness script (validate a backend OpenAPI against the contract; mock's own OpenAPI = first conformance test)  [deps: T00]
- [ ] P2-INIT skein-ready --init — read a backend's OpenAPI, auto-detect base URL + prefix remap + auth scheme (requiresToken), emit ready-to-paste agentic.config.ts target block (user feature 2026-08-05)  [deps: READY]
- [ ] P2-T07 Auth both AUTH_MODEs — mock JWT endpoints + seeded users, login screen, token handling/401s, /me both modes, no AUTH_MODE branches in components  [deps: T00]
- [ ] P2-T07b/07c Admin — members permission matrix (view/tune/evaluate) + tree enable/disable (read-only history)  [deps: T07]
- [ ] P2-SHARE Copy-link sharing — conversation ⋯ menu + turn action links (/chat/{id}?turn=), scroll+highlight on open, no-access state; works in both AUTH_MODEs via T07's return_to redirect (user feature 2026-08-05)  [deps: T07]
- [ ] P2-T12 Eval workbench — cases/sets/rubrics CRUD, hand-crafted references, CSV/XLSX import (sketch 10)  [deps: T00]
- [ ] P2-T12a Inspector + Casebooks (inspect role, audit-logged; casebook → eval set / replay suite)  [deps: T07, T12]
- [ ] P2-CTX Context policy widening — frozen/today/custom + fallback + recorded-tools playback (extend sketch 03)  [deps: T00]
- [ ] P2-GEN Generator control API + Settings drip-rate controls  [deps: T00, T17]
- [ ] P2-MEM Memory panel — view/edit/clear per tree, compaction as queued task  [deps: T00]
- [ ] P2-MOBILE-SHELL Portrait shell fix — burger toggle, sidebar overlay closes on navigation, chat usable on phone; studio pages stay desktop-only (document in features.md)  [deps: none]
- [ ] P2-MSW Full MSW parity for unit tests
- [ ] P2-T19b k8s manifests + Helm post-upgrade Playwright job (artifacts + local validation; no live cluster)  [deps: E2E suite]
- [ ] P2-E2E Full Playwright suite — 13 journeys × both auth modes, endpoint-tag interception  [deps: T07, T12, T17]
- [ ] P2-RECORD Minimal e2e recording — Playwright `record` project (video:on, slowMo) + npm run e2e:record + ~30-line step-HUD banner helper; built-in HTML report = the review gallery. NO gif tooling/cursor/manifest/gallery (those are PRO-3 Reels)  [deps: none; richest after P2-E2E]
- ~~P2-T20 repo/PR~~ — PRO TIER, excluded from free build (user decision 2026-08-05); design stays in feature-spec only

## After Phase 2 (user decision 2026-08-05): FULL STOP — no Phase 3 (scaffold) or Phase 4 (hosted).
## Next focus after Phase 2 close = a UX polish phase, desktop-first, planned WITH the user before any task runs.
## UX-phase candidate (user-approved 2026-08-05): "whitelabel-lite" — npm run init (asks name/label/backend, writes agentic.config.ts) + wire product.label through all UI strings; full Phase-3 scaffolder stays parked.

## PRO phases (plans only — NOT scheduled; do not build in free phases; user decisions 2026-08-05)
- PRO-1 "Agents as Code" — repo/PR integration: GitHub connect, instruction diffs as PRs, merge promotes live; mock git server (former P2-T20)
- PRO-2 "Public Sharing" — anonymous tokenized share links for conversations/turns (expiry, revocation); free tier keeps in-app deep links only (P2-SHARE)
- PRO-3 "Reels" (working name) — watchable-QA journey runner: journeys.yaml testability contract → Playwright films (step HUD, cursor, chapters, pass/fail) + review gallery → standalone CLI → hosted CI product. P2-E2E deliberately excludes this video harness.
- FUTURE "Hybrid backend fill" (skipped 2026-08-05, keep) — per-feature-family routing: implemented endpoints → user backend, missing families → bundled mock, table derived from the skein-ready gap report; visible "served by mock" badges; demo-quality only (no cross-store data joins).
