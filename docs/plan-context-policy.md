# Plan — P3-CTX, "choose the replay context" (PLAN ONLY, do not build yet)

## What this delivers

Today every replay runs **frozen**: each turn re-executes under the date, timezone, region
and locale it recorded when it first ran, so the only thing that varies is your change.
That is the right default and it stays the default. This task adds the choice:

- **frozen** — the original recorded context (default, unchanged)
- **today** — the current context, for "does this still work now?"
- **custom** — a context you type in, for "what happens on 1 January?"
- plus a **fallback rule** for turns that recorded no envelope at all
- plus **tools mode**: re-run tools live, or replay the tool results the turn originally got,
  so only the model's behaviour varies

## The good news: the contract is already done

`P2-T00` widened the contract for exactly this in v0.3.0. Verified present in `openapi.yaml`:

| Field | Where | State |
|---|---|---|
| `context_policy: [frozen, current, custom]`, default `frozen` | ReplayRequest, ReplayTurnRequest, CasebookReplayRequest | ✅ in contract |
| `context_override` (a ContextEnvelope, required when policy is `custom`) | same three | ✅ in contract |
| `fallback_policy: [settings, error]` | same three | ✅ in contract |
| `tools_mode: [live, replay_recorded]`, default `live` | same three | ✅ in contract |
| `RunCell.envelope_source` (`original` / `override` / `fallback`) | Run schema | ✅ in contract |
| `Settings.fallback_envelope` | Settings | ✅ in contract |

**So this task is implementation only — no contract change, no version bump.**

## What actually has to change

### 1. Mock — lift the three frozen guards

`mock/main.py:1127`, `:1205`, `:2128` each reject any non-frozen policy with 422
(`Phase 1 replays always run frozen`). All three come out, replaced by real handling:

- resolve the effective envelope per row: `frozen` → the source turn's envelope; `current` →
  stamp now; `custom` → `context_override` (422 if absent, per the contract);
- when a turn has **no** envelope (permitted on legacy/imported turns), apply `fallback_policy`:
  `settings` → use `Settings.fallback_envelope`; `error` → fail that cell, not the batch;
- record which happened in `RunCell.envelope_source` so the grid can show it.

The plumbing is already in place: `Engine.regenerate(..., envelope=...)` (`mock/engine.py:384`)
already takes the envelope per call and stamps it on the new turn — today it is simply always
handed the frozen one from `run_rows.envelope`.

### 2. Mock — `tools_mode: replay_recorded`

Today `_emit_trace` (`mock/engine.py:275`) *invents* a tool span (`search_kb`, hash-gated at
`:293`) with fresh args and results. For `replay_recorded` it must instead read the source
turn's tool spans — `spans.args` / `spans.result` already exist (`mock/db.py:90`) and back
`GET /spans/{id}/payload` — and re-emit those values rather than generating new ones.

Honest scope note: the bundled backend has no real tools, so "replaying recorded results"
here is faithful in *shape* (same tool, same args, same result, only the model output varies)
rather than a genuine tool-execution bypass. A real backend's implementation is the one that
matters; ours is the reference for what the contract means. Say so in the code and the docs.

### 3. A dependency worth surfacing early

**`fallback_policy: settings` reads `Settings.fallback_envelope`, and `GET/PUT /settings` is
not implemented in the mock** — it is one of the eight remaining unimplemented operations.
Options, in order of preference:

1. Implement the `fallback_envelope` slice of `/settings` as part of this task (small — a
   single stored document), and leave the rest of Settings for later.
2. Ship `fallback_policy: error` only, and 501 the `settings` branch until `/settings` lands.

Option 1 is recommended: without it the feature's most useful fallback is unreachable, and
the endpoint is trivial compared with the rest of this work.

### 4. Client — stop hard-pinning frozen

`src/api/client.ts:503` and `:512` currently take `Omit<ReplayRequest, "context_policy">` and
hard-set `frozen` (`:506`, `:515`), with `casebookReplay` doing the same at `:335-340`. That
pin was deliberate in Phase 1 — it made the invariant machine-checkable. It now comes out:
the three fields become real, optional parameters, defaulting to today's behaviour so every
existing call site is unaffected.

Keep the defaults explicit in the client rather than relying on the server's, so a
misconfigured backend cannot silently change what a replay means.

### 5. UI — a context section in Run Config

`src/components/RunConfigPanel.tsx` has **no context UI at all** today. Add a collapsed
section (the judge section is the precedent — same component, same pattern):

- radio: Original context (default) · Today · Custom
- custom reveals four fields (date, timezone, region, locale), prefilled from the first
  selected turn's envelope so it is an edit rather than a blank form
- a fallback selector, only shown when the selection actually contains an envelope-less turn
  — otherwise it is noise
- tools: Run tools live (default) · Replay recorded results

Then surface the consequence where results are read:

- `ComparisonView` — cells whose `envelope_source` is `fallback` or `override` get a small
  marker, so a reader never mistakes a fallback for the real thing
- the run header states the policy in words: *"Replayed under each turn's original context"*
  or *"Replayed under 2026-01-01 · Europe/London"*
- `EnvelopeChip` (`src/components/EnvelopeChip.tsx`) already renders an envelope and can be
  reused verbatim

Sketch 03 gains this section; sketch 04 gains the cell marker.

### 6. Tests

- **pytest**: each policy resolves the expected envelope; `custom` without `context_override`
  → 422; envelope-less turn under each fallback policy (settings → uses it; error → that cell
  fails, siblings still succeed); `envelope_source` set correctly per row; `replay_recorded`
  re-emits the source tool span's args and result verbatim; **frozen remains the default when
  the field is omitted** (the regression that matters most).
- **vitest**: the panel emits each shape; custom validation; the fallback selector appears
  only when relevant; cell markers render; the run header reads correctly.
- **e2e**: extend journey 3 or 5 — replay the same conversation under `frozen` and under
  `today` and assert the two runs' cells carry different `envelope_source`/dates.

## Order

1. `/settings` fallback_envelope slice (unblocks the rest)
2. Mock: policy resolution + fallback + `envelope_source`
3. Mock: `tools_mode: replay_recorded`
4. Client: unpin, expose the three fields
5. UI: Run Config section + result surfacing
6. Docs: features.md flips this line from planned to shipped

Roughly one task per numbered item; 2 and 5 are the substantial ones.

## Risks

- **Quietly breaking the default.** Every existing replay must still run frozen when nothing
  is specified. That is one assertion, and it should exist in all three test layers.
- **The invariant loosens.** "Replays always run frozen" has been machine-checked since Phase 1
  and several tests encode it. Those tests are not wrong — they need to become "frozen unless
  explicitly asked otherwise". Update them deliberately and say which changed.
- **`replay_recorded` is only as honest as the recorded spans.** If a turn's trace has no tool
  spans, the mode silently does nothing. Decide whether that is a no-op or a cell error, and
  document it.
