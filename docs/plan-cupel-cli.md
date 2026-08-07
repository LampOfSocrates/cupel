# Plan — `cupel-cli` (Phase 3, PLAN ONLY — do not build yet)

User decision 2026-08-06: a second CLI, separate from the scaffolder, that is simply
**a terminal client to any conformant backend**:

```
cupel-cli --mybackend XXXX <command> …
```

Lives in `cli/cupel-cli/`. Sibling to `cli/agentic-app-maker/` (which *generates*
projects); this one *drives* a running backend. Originally sketched in feature-spec.md's
Phase-3 bullet: "Do everything from the terminal … same API as the UI, `--json` for
scripts, works against any conformant backend."

**No implementation until Phase 3 starts.**

## Why it exists

Three distinct users, one tool:

1. **Backend implementers** — exercise their half-built server without opening a browser,
   and see exactly which call failed and how.
2. **Scripters / CI** — `--json` everywhere, so replay-and-judge can run in a pipeline
   without Playwright.
3. **Us** — debugging the mock and the contract during development. Today this means
   hand-written `curl` and `Invoke-RestMethod` one-liners scattered across task reports;
   this replaces them with something tested.

## Target selection

- `--mybackend <base-url>` — point at anything (the bundled mock, localhost, staging).
- No flag → resolve from `agentic.config.ts` (`defaultTarget`, honouring `remap`), so a
  checkout Just Works. Same one-config-artifact rule as the UI; no second source of truth.
- `--token <jwt>` / `CUPEL_TOKEN` env, plus `cupel-cli login --email …` writing to a
  local credentials file. In `AUTH_MODE=off` backends, no token is needed and none is sent.
- `--llm-key` passthrough for BYOK-capable backends (never persisted, mirroring the UI rule).

## Command surface (mirrors the contract, not the UI)

| Command | Contract call |
|---|---|
| `health` | `GET /healthz` (+ latency, version, seed) |
| `me` | `GET /me` |
| `trees` | `GET /agenttrees` |
| `chat <message>` | `POST /agenttrees/{tree}/chat` — **streams tokens to the terminal**; `--no-stream` for the JSON path; `--conversation <id>` to continue |
| `conversations [list\|show <id>\|rm <id>]` | conversations endpoints, `--search`, `--forks-of` |
| `agents [list\|show <id>]` | agent hierarchy |
| `instructions [get\|save] <agent>` | versioned instructions; `save` reads a file or stdin (append-only, prints the new version) |
| `replay` | `POST …/replay` with a selection + config; prints the run id |
| `run <id>` | run detail; `--watch` re-renders the grid as cells fill |
| `judge --run <id> --rubric <id>` | `POST /eval/judge` |
| `judgments --run\|--case\|--turn` | judgment history |
| `tasks [--watch]` | `GET /tasks`, and `--watch` tails `GET /tasks/stream` |
| `trace <turn-id>` | span tree, `--span <id>` for the payload |
| `ready` | delegates to the existing `cupel-ready` comparator (one implementation, two front doors) |

Global flags: `--json` (machine output on every command, no decoration), `--tree <id>`,
`--quiet`, `--verbose` (prints the request line and status of every call — the debugging
feature that makes this worth building).

## Design rules

- **Node ESM, no runtime dependencies**, matching `scripts/cupel-ready.mjs`.
- **Share, don't fork**: the SSE frame parser exists in `src/api/sse.ts` and the conformance
  comparator in `scripts/conformance.mjs`. Extract the parser to a shared JS module both the
  UI and the CLI import, rather than writing a second one that drifts. (The UI's copy is
  TypeScript; the extraction is part of the task, not an afterthought.)
- **Human output is decorated, `--json` is not.** No colour codes, spinners, or progress
  bars in `--json` mode; exit codes meaningful (0 ok, 1 request failed, 2 usage error).
- **Streaming is the point.** `chat` and `tasks --watch` must render live, handle Ctrl+C
  cleanly, and cancel the server-side task on interrupt (`DELETE /tasks/{id}`) rather than
  orphaning it.
- **Never invent endpoints.** If the contract doesn't have it, the CLI doesn't do it.

## Acceptance criteria

1. Every command works against the bundled mock with zero configuration
   (`npm start` in one terminal, `cupel-cli chat "hello"` in another).
2. `--json` output is valid JSON on stdout with nothing else mixed in — verified by piping
   every command through a parser in tests.
3. `chat` streams tokens and Ctrl+C cancels the task server-side (assert the task's status
   is `cancelled` afterwards).
4. Works against an `AUTH_MODE=on` backend: `login` → subsequent commands authorised → a
   restricted user gets a clean "not permitted" message, not a stack trace.
5. Zero duplicated SSE-parsing or conformance logic (a test asserts the shared module is
   the only implementation).

## Open decisions

- **Q1. Config file for defaults** (`~/.cupel/config.json` with a default backend and tree)
  — convenient, but a second source of truth alongside `agentic.config.ts`. Recommendation:
  credentials only in `~/.cupel/`; everything else from flags or the repo config.
- **Q2. Does it ship on npm as a standalone package** (`npx cupel-cli`) or only from a
  checkout? Recommendation: checkout-only at first; publishing is a release decision, not a
  build one.
- **Q3. `fav` / aliases** (the original spec's `loom fav refunds`). Recommendation: defer —
  it needs the config file from Q1 and adds little before real usage shows what's tedious.

## Task breakdown (for TASKS.md when Phase 3 starts — NOT before)

- **P3-CLI2-A** — skeleton: arg parsing, target/auth resolution from `agentic.config.ts`,
  `--json`/`--verbose`/exit codes, `health`/`me`/`trees`.
- **P3-CLI2-B** — shared SSE module extraction (UI + CLI import one implementation), then
  `chat` with live streaming and Ctrl+C cancellation.
- **P3-CLI2-C** — studio commands: conversations, agents, instructions, replay, run
  `--watch`, judge, judgments, trace.
- **P3-CLI2-D** — `tasks --watch`, `ready` delegation, auth flows against `AUTH_MODE=on`,
  and the acceptance walk.
