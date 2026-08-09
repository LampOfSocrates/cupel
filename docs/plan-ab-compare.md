# Plan — A/B compare in chat and studio (PLAN ONLY, do not build yet)

User idea, 2026-08-07: *"sometimes you want to talk to multiple backend servers or even
different versions of an agent tree, to do a kind of A/B testing. This can happen in chat
mode as well as studio mode, and judging can also apply. Make it easy to configure. Studio is
DEV-users only, and this feature in chat is DEV-users only too."*

## 1. Most of this already exists — retroactively

The comparison machinery is built. What is missing is doing it **live, while you chat**, and
doing it **across backends** rather than across deploy targets within one backend.

| Already shipped | What it does | Gap |
|---|---|---|
| Turn re-fire (`P1-T13`) | `POST /replay/turn` with `endpoints[]` → a real conversation per endpoint, all under one `run_id` | Only on a turn that already exists |
| Fork pivot (`P1-T14`) | Renders those results as a grid, column per endpoint | — |
| Evaluations (`P1-T11`) | `configs[]` A/Bs instruction versions and models across many conversations | Cannot vary the endpoint |
| Judging (`P1-T12b`) | Scores a whole run, per cell, with a summary header | Works only on a run |
| Backend switcher (`P2-T17`) | Switch the active target live | Exactly one active target at a time |

Two hard edges in today's design:

- `RunConfig.endpoint_ids` is scoped by the contract to turn re-fire only
  (`openapi.yaml`: *"endpoint_ids only applies to turn re-fire"*), so *"replay these 20
  conversations against staging and prod"* is not expressible.
- `src/api/target.ts` is deliberately singular — `getActiveTarget()` returns one target and
  every call in `src/api/client.ts` resolves its base URL from it.

## 2. The fork that decides the cost

### 2a. A/B **within one backend** — cheap, and the right first move

Varying endpoint, instruction version, model or temperature. The server can fan this out
itself, and already does for turn re-fire: one request, N conversations, **one `run_id`**.

Chat compare then becomes *"re-fire, but for a new message instead of an existing turn"* — and
because the result is a run, the comparison grid, the judge, the summary, the queue, cancel
and retry-failed all work **unchanged**. That reuse is the whole argument for doing this first.

### 2b. A/B **across backends** — genuinely new, and structurally harder

Staging vs prod vs a colleague's laptop are different servers. Nobody can fan that out but the
client, and the results live in different databases, so:

- there is no shared `run_id`, so the existing grid and judging do not apply;
- judging has to happen somewhere — nominate one backend as the scorer (it would be judging
  text produced elsewhere, which is legitimate but must be labelled), or judge client-side;
- `src/api/client.ts` currently resolves one base URL for every call, so this needs a
  per-request target override threaded through the client. That is the structural change.

**Recommendation: build 2a first and ship it. Treat 2b as a separate, later item** — and note
it overlaps `P4-HYBRID`, which already contemplates talking to more than one backend (for
gap-filling rather than comparison) and would pay for the same client refactor.

## 3. What gets built (2a)

### Chat compare mode
- A **compare toggle** in the chat header, visible only with `tune` on the current tree.
- Picking 2–3 variants: endpoints from `GET /agenttrees/{tree}/endpoints`, and/or instruction
  versions, and/or models — the same fields `RunConfigPanel` already collects.
- Sending a message fans out server-side; the transcript splits into N columns, each streaming
  its own reply, with the shared user turn above them.
- The result **is a run**: a "See the comparison" link opens the existing grid, and the judge
  works on it with no new code.
- Leaving compare mode returns to a normal single conversation. Each column is a real
  conversation you can open and continue — same as forks today.

### Studio
- Widen `endpoint_ids` to whole-conversation replay so a run can vary the deploy target as
  well as the version/model. This is an **additive contract clarification** (relaxing a
  documented restriction), not a new endpoint — but it *is* a contract change, so it belongs
  with `P3-T00` (contract v0.4.0) rather than being smuggled in.
- `RunConfigPanel` already renders an endpoints multi-select behind a `showEndpoints` flag
  (built in `P1-T09`, currently passed `false` by the Evaluations stepper). Turning it on is close to
  a one-line change once the contract allows it.

### Configuration
Named comparison sets in `agentic.config.ts`, so a team's usual A/B is one click and not a
five-field form each time:

```ts
compareSets: [
  { id: "staging-vs-prod", label: "Staging vs prod", endpoints: ["staging", "prod"] },
  { id: "v-last-two",      label: "Current vs previous version", versions: "last-2" },
]
```
Config supplies the *presets*; the UI still allows an ad-hoc selection. Keep it in the one
config artifact — no second source of truth.

### Dev-only gating — free, no new concept
Do **not** invent a "dev" role. The permission model already carries `view / tune / evaluate`
per tree (`openapi.yaml:2022`). A/B is a tuning activity:

- compare mode in chat requires `tune` on the active tree;
- the studio already sits behind the same permissions.

No contract change, no `AUTH_MODE` branch, and a read-only viewer simply never sees the
toggle. `Me.permissions` is already fetched on boot.

## 4. Code impact

| File | Change | Size |
|---|---|---|
| `src/pages/ChatPage.tsx` | One conversation, one stream, one draft store today (`:193`). Compare mode = N parallel streams and N draft stores in columns. **The `StreamingBubble` extraction from review bucket A makes this far cheaper than it would have been** — the per-token state is already isolated | large |
| `src/api/client.ts` | A fan-out call for compare-send; no base-URL change needed for 2a | small |
| `agentic.config.ts` | `compareSets` presets | small |
| `src/components/RunConfigPanel.tsx` | Flip `showEndpoints` on for the Evaluations stepper (after the contract widens) | trivial |
| `openapi.yaml` | Widen `endpoint_ids` beyond turn re-fire — **fold into `P3-T00`** | small |
| `src/api/target.ts` | Only for 2b: per-request target override | medium |

**Sequencing note:** this lands most cheaply *after* Stage A's `PB-1` (splitting `ChatPage`),
because compare mode adds a second layout to a file that is already 1.1k lines and four
concerns. Building it before the split would make both jobs worse.

## 5. Risks

1. **Chat becomes a studio.** The chat half's value is that it is simple enough to hand to a
   user. Compare mode must stay behind `tune` and out of the way — a toggle, not a mode
   everyone lives in.
2. **N streams, N costs.** Sending one message to three variants is three generations, three
   bills. Say so in the UI before the send, not after.
3. **Column count.** Three is readable on a desktop; beyond that it is a grid, and the grid
   already exists — cap the chat view and send people to Evaluations.
4. **2b's judging story is unresolved.** Do not start cross-backend compare until "who scores
   it, and is that labelled" has an answer.

## 6. Tasks to add when this is scheduled

- **PAB-1** — chat compare mode within one backend: `tune`-gated toggle, N-column transcript,
  server-side fan-out, result opens the existing grid. *(deps: PB-1 ChatPage split)*
- **PAB-2** — studio: widen `endpoint_ids` in the contract (fold into `P3-T00`), turn on the
  endpoints multi-select in the Evaluations stepper.
- **PAB-3** — `compareSets` presets in `agentic.config.ts` + the picker UI.
- **PAB-4** *(later, separate)* — cross-backend compare: per-request target override in the
  client, N unrelated conversations, and a decided answer on where judging happens. Overlaps
  `P4-HYBRID`; do not start without §5.4.
