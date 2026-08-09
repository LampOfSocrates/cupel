# Spike: should Cupel speak AG-UI?

Research spike, 2026-08-07. Deliverable is this document. No product code was
changed; the prototype lives outside the repo (paths in §4).

**Evidence key** — `[V]` = verified by running code or reading the file/package
named. `[I]` = inferred from documentation or reasoning, not executed.

---

## 1. Summary and recommendation

**Recommendation: adopt-partially — speak AG-UI at the *backend edge*, not in
the client. Do not change `openapi.yaml`'s chat half.**

Concretely: ship a reference **AG-UI bridge** — a small server that implements
the Cupel contract and proxies its generation call to any AG-UI endpoint,
persisting turns, envelopes, tasks and spans in its own store. Do *not* add an
AG-UI transport to `src/api/client.ts`, and do *not* add a
`target.protocol: cupel | agui` switch that bypasses the contract.

The reason is one structural fact the spike made concrete:

> **Our `POST /agenttrees/{tree}/chat` is a write. AG-UI's run endpoint is a
> pure function call.**

`openapi.yaml:855-926` doesn't just stream tokens — it creates a conversation,
appends a user Turn, stamps a `ContextEnvelope` at generation
(`openapi.yaml:2220-2232`), mints a server-authoritative `task_id` cancellable
from another connection (`openapi.yaml:1241-1253`), persists the partial turn
on cancel (`openapi.yaml:875-877`), and emits spans on a separate channel for
the trace/cost view. AG-UI defines none of that. It defines a stateless
`RunAgentInput -> event stream` call `[V]`.

Cupel is a pure client — "YOUR backend holds all persistence — Cupel itself
stores nothing server-side" (`agentic.config.ts:75`). So a *client-side* AG-UI
adapter produces a chat widget with no history, no replay, no judgments and no
traces. That is not the product. The place where AG-UI's statelessness can be
repaired is a server, and we already ship one (`mock/`, 61 of 69 operations),
and the phase plan already anticipates exactly this shape: "any backend at all
via a small adapter module — **with the mock filling in whatever your backend
doesn't do yet**" (`cupel-phases.md:75`).

The second reason is arithmetic. AG-UI covers the wire format of **one** of our
69 operations (§5a). The framework builder's cold-start tax is not the chat
endpoint — it is the ~40 studio operations AG-UI has no opinion about. Speaking
AG-UI in the client removes ~1.4% of the tax and costs us the envelope,
idempotency, server-side cancel and the entire persistence layer. Speaking it in
a bridge removes ~100% of the tax, because the bridge implements the contract
and the adopter implements nothing.

The third reason is that AG-UI is **not yet a specification**. There is no
protocol version number anywhere, no spec document — the normative artifact is
a Zod schema in `@ag-ui/core` (0.0.57) hand-mirrored into the other SDKs — and
releases are date-tagged with no protocol changelog (§2.2). Governance is
single-vendor with no charter, TSC, CLA or RFC process, ~80% of commits from
one payroll, and no foundation donation, in pointed contrast to MCP and A2A
(§2.1). Adopting it *into* `openapi.yaml` — a document we ask third parties to
implement — would make our contract downstream of an unversioned file owned by
one company. Adopting it *at the edge* costs us nothing if it churns.

Three things to be clear about, because they cut in AG-UI's favour: the
adoption is real (Microsoft's integration is genuinely first-party and marked
Production/Stable), the design is genuinely small and clean, and its taxonomy
is a free design review that exposes three real holes in our contract —
human-in-the-loop interrupts, a reasoning surface, and frontend tool calls
(§5c). We should fix those regardless of what we decide about the wire.

---

## 2. What AG-UI actually is (findings)

### 2.1 Identity, licence, governance

- **AG-UI (Agent-User Interaction Protocol)**, "an open, lightweight,
  event-based protocol that standardizes how AI agents connect to user-facing
  applications" — <https://docs.ag-ui.com/> (fetched 2026-08-07) `[V]`.
- Repo: <https://github.com/ag-ui-protocol/ag-ui> (15.2k stars, 1.37k forks,
  315 open issues; 100 commits between 2026-07-29 and 2026-08-06 — development
  is vigorous) `[V]`.
- Positioned as a peer of MCP (agent↔tools) and A2A (agent↔agent); AG-UI is
  agent↔user-facing-app `[V, README]`.
- **Licence: MIT, with sloppy edges.** The root `LICENSE` reads
  `Copyright (c) 2025` with **no named holder**; the `docs/` subtree has its own
  MIT file attributed to **Tawkit, Inc.** (CopilotKit's Delaware entity) and
  Markus Ecker — so the spec prose is copyright the company. `@ag-ui/core`'s
  `package.json` has **no `license` field at all** `[V]`. No separate CC-BY
  licence for the spec text.

**Governance: single-vendor, with no mitigating structure.** This was the
sharpest finding of the whole spike, and all of it is `[V]`:

- `.github/CODEOWNERS` line 1 is `* @ag-ui-protocol/copilotkit`. Everything.
- **No** `GOVERNANCE.md`, charter, TSC, code of conduct, CLA, DCO, trademark
  notice, `rfcs/` or `proposals/` directory. `CONTRIBUTING.md`'s strongest
  statement is "A maintainer will review your code."
- The `ag-ui-protocol` GitHub org has **zero public members**
  (`/orgs/ag-ui-protocol/members` returns `[]`) and is not GitHub-verified.
- The "bi-weekly AG-UI Working Group" is one README line pointing at a
  **CopilotKit-branded** Luma calendar that renders **no events at all**, past
  or upcoming. No minutes, agendas, recordings or attendee list exist publicly.
  **I could not verify these meetings occur.**
- Commit concentration: top contributors are ranst91 (585), jpr5 (422),
  contextablemark (385), mme (256 — Markus Ecker, CopilotKit CTO),
  NathanTarbert (179), tylerslaton (162). **Roughly 80% of top-14 human commits
  are CopilotKit payroll**, ~96% counting an outside contractor. Genuinely
  independent participation exists but is tiny: Datadog (62 commits),
  Microsoft's javiercn (21), Pydantic AI's stevenh (8).
- **No foundation donation.** MCP went to the Linux Foundation's Agentic AI
  Foundation (formed 2025-12); A2A went to the LF in 2025-06. AG-UI has done
  neither, three months after a raise that named "further developing AG-UI as
  an open industry standard" as a use of funds.
- CopilotKit (Seattle; founders Atai and Uli Barkai, ~20-25 staff) raised
  **$27M total — a $20.5M Series A led by Glilot Capital Partners with NFX,
  SignalFire and 97212 Ventures, plus $6.5M seed — announced 2026-05-05**
  (<https://techcrunch.com/2026/05/05/copilotkit-raises-27m-to-help-devs-deploy-app-native-ai-agents/>).

**Adoption depth — the README's "1st Party" table is not trustworthy.** Every
"1st party" row links to `docs.copilotkit.ai`, not the vendor's own docs.
Sorted by actual evidence `[V]`:

| Vendor | Reality |
|---|---|
| **Microsoft** | Genuinely first-party and the deepest of all — PyPI `agent-framework-ag-ui` **v1.0.1, author "Microsoft", Production/Stable** (2026-07-23), plus NuGet and Go; docs on learn.microsoft.com (2026-07-10) |
| **Pydantic AI**, **Agno**, **LlamaIndex** | First-party, in-core modules |
| **Google ADK** | Doc page in Google's repo, but the code (`ag-ui-adk`) is authored by an outside contractor. Python only |
| **LangChain** | Partner-maintained; framed in LangChain's own docs as *a CopilotKit integration* |
| **AWS Strands** | **Vendor-disclaimed** — Strands' docs file it under `/community/` with "not owned or supported by the Strands team", repeated in the AWS Open Source Blog (2026-07-16). Bedrock AgentCore does have a real AG-UI runtime doc |
| **CrewAI** | Near logo-only; no AG-UI page found on docs.crewai.com |

So "adopted by Google, Microsoft, AWS" is a claim about *integrations
existing*, not about shared control — and AWS explicitly disowns theirs. The
adoption is real enough to treat AG-UI as the de-facto wire; it is not evidence
of governance neutrality.

### 2.2 Versioning and stability — the important finding

Package registries, queried 2026-08-07 `[V]`:

| Package | Latest stable | Released | Notes |
|---|---|---|---|
| `ag-ui-protocol` (PyPI) | **0.1.19** | 2026-06-02 | dev builds `0.1.20.devN` up to 2026-07-31 |
| `@ag-ui/core` (npm) | **0.0.57** | 2026-06-12 | canaries `0.0.59-canary` / `0.1.1-canary.beta` to 2026-07-31 |
| `@ag-ui/client` (npm) | 0.0.57 | 2026-06-12 | |

Neither SDK has reached 1.0 after the protocol's rise to prominence. There is a
`0.1.1-canary.beta` line on npm (2026-07-30) suggesting an in-flight minor bump
`[V]`.

Three findings here matter more than the version numbers, all `[V]`:

1. **There is no protocol version number.** Not in the docs, not in
   `BaseEvent`, not in `RunAgentInput`, not in any header. No version
   negotiation exists.
2. **There is no spec document.** The normative artifact is the Zod schema in
   `@ag-ui/core`, hand-mirrored into Python, .NET, protobuf and ~7 community
   SDKs. Issue #1570 (opened 2026-04-22, still open) *asks for* a
   machine-readable JSON Schema of the event types — i.e. no language-neutral
   artifact yet exists.
3. **Releases are date-tagged, not semver**: `release/2026-08-04`,
   `release/2026-07-31`, `release/2026-07-28`… roughly weekly, cut by CI, with
   release notes containing only a table of package versions and **no protocol
   changelog**. Breaking changes are handled ad hoc and additively (the
   interrupt work is a careful example — `outcome` was made optional so old
   producers still validate), but that is convention, not policy.

Supporting signals: the docs' own "What's New" page has exactly one entry —
**2025-04-09, "AG-UI repositories are now public"** — making it 16 months
stale; the roadmap page is a 12-line stub linking to a GitHub Projects board
that is **not publicly readable** (verified directly). The only v1.0 signal
anywhere in the project is a JSDoc comment on the deprecated `THINKING_*`
events: *"Will be removed in 1.0.0."* No date, no milestone.

**Assessment:** widely adopted, genuinely useful, and defined by an
implementation rather than a specification. Aligning `openapi.yaml` — a
document we ask *third parties* to implement — to an unversioned schema whose
canonical form is a Zod file would import that instability into our contract.

### 2.3 Transport and wire format `[V — measured, not read]`

I stood up a server and read the bytes:

```
data: {"type":"RUN_STARTED","threadId":"t1","runId":"r1"}

data: {"type":"TEXT_MESSAGE_START","messageId":"bffe...","role":"assistant"}

data: {"type":"TEXT_MESSAGE_CONTENT","messageId":"bffe...","delta":"Hello"}
```

- Transport over HTTP is **SSE** (`Content-Type: text/event-stream`), confirmed
  by `EventEncoder().get_content_type()` `[V]`.
- **There is no SSE `event:` field.** The discriminator is `"type"` *inside the
  JSON body*, in `SCREAMING_SNAKE_CASE`. Payload keys are `camelCase` `[V]`.
- The encoder ignores content negotiation entirely: `EventEncoder(accept=...)`
  accepts the header and discards it, always returning `text/event-stream` `[V
  — I passed an `Accept` header and got SSE regardless]`. Every AG-UI example
  server threads `accept` into the encoder; in Python that call is decorative.
- **The "transport agnostic" claim is thinner than advertised** `[V]`. Protobuf
  over HTTP chunked (`application/vnd.ag-ui.event+proto`, 4-byte big-endian
  length prefix) exists in the TypeScript and .NET clients, but the Python SDK
  cannot emit it, the JS client always sends `Accept: text/event-stream` so it
  never negotiates it, its docs page is a four-line stub, and the `Event` oneof
  in `events.proto` covers **18 of the 33 event types** (all reasoning events,
  `TOOL_CALL_RESULT` and both activity events have no protobuf form).
  **WebSockets are not implemented in any official SDK** —
  `AbstractAgent.connect()` throws `AGUIConnectNotImplementedError` by default.

**Canonical transport: HTTP POST + SSE. Everything else is aspiration or
partial.** There is also **no path convention** — reference servers mount at
`/`, and clients are configured with a full URL. No discovery, no agent card,
no manifest `[V]`.

**Direct consequence for us `[V]`:** our own parser handles the framing fine,
but our consumer does not. Running an AG-UI stream through
`src/api/sse.ts:99 parseSseStream` yields 12 frames, all with
`event === "message"`, of which
`src/api/client.ts:201 chatEvents()` — which switches on the SSE event name —
would emit **zero**. Any integration therefore requires a translation layer, not
a config flag.

### 2.4 Request shape `[V — from `ag_ui.core.RunAgentInput`, 0.1.19]`

> **Naming, to avoid a false match:** every `run_id` / `parent_run_id` / `runId` on this page
> is **AG-UI's** field — one agent invocation in someone else's protocol. It is unrelated to
> what Cupel used to call a run: that noun is now `Evaluation` and its field is
> `evaluation_id` (item 7). AG-UI's `runId` maps to our `task_id`, not to `evaluation_id`.

```
thread_id: str            (required)
run_id: str               (required)
parent_run_id: str | None
state: Any                (required)
messages: list[Developer|System|Assistant|User|Tool|Activity|Reasoning Message]
tools: list[Tool]         Tool = {name, description, parameters}
context: list[Context]    Context = {description, value}   <- untyped str pairs
forwarded_props: Any      (required)
resume: list[ResumeEntry] | None
```

There is **no idempotency key**, **no cancellation verb**, **no resume-a-
dropped-stream mechanism**, and **no user or tenant identity** — auth is
delegated entirely to HTTP headers, and there is no security page in the
57-page docs index `[V]`. `resume` is for human-in-the-loop interrupts, not
transport reconnection.

**Cancellation in practice:** the client aborts the HTTP request; the server
sees a transport disconnect. `@ag-ui/client` synthesises a *client-side*
`RUN_ERROR` with `code: "abort"` — see ag-ui issue #880 (opened 2025-12-29,
closed), a bug report that this synthesised event was missing its required
`message` field `[V]`. That is the maturity level of the cancellation story.

**Stream resumption is structurally impossible, not merely unimplemented.**
`BaseEvent` is `{type, timestamp?, rawEvent?}` — no sequence number — and the
SSE parser explicitly discards `id:` lines, so even the standard
`Last-Event-ID` mechanism is unavailable. Issue #2105 (opened 2026-07-02, still
open) states it exactly: *"a client has nothing to resume from, and a server
has no key to resume at. The capability flag exists but the wire contract
doesn't."* A production LangGraph adapter maintainer reported on 2026-07-27
that they reattach to durable runs via `forwardedProps.reattach` + the original
`runId`, calling it *"a protocol divergence / extension"* `[V]`.

**Idempotency** appears once, as a requirement placed on *implementers* rather
than a mechanism the protocol provides: the interrupts doc says a resume with
the same `(threadId, interruptId, status, payload)` "must be safe to replay".

### 2.5 Event taxonomy `[V — enumerated from `ag_ui.core.EventType`, 0.1.19]`

33 event types, exact wire spellings:

`TEXT_MESSAGE_START` · `TEXT_MESSAGE_CONTENT` · `TEXT_MESSAGE_END` ·
`TEXT_MESSAGE_CHUNK` · `THINKING_TEXT_MESSAGE_START` ·
`THINKING_TEXT_MESSAGE_CONTENT` · `THINKING_TEXT_MESSAGE_END` ·
`TOOL_CALL_START` · `TOOL_CALL_ARGS` · `TOOL_CALL_END` · `TOOL_CALL_CHUNK` ·
`TOOL_CALL_RESULT` · `THINKING_START` · `THINKING_END` · `STATE_SNAPSHOT` ·
`STATE_DELTA` · `MESSAGES_SNAPSHOT` · `ACTIVITY_SNAPSHOT` · `ACTIVITY_DELTA` ·
`RAW` · `CUSTOM` · `RUN_STARTED` · `RUN_FINISHED` · `RUN_ERROR` ·
`STEP_STARTED` · `STEP_FINISHED` · `REASONING_START` · `REASONING_MESSAGE_START` ·
`REASONING_MESSAGE_CONTENT` · `REASONING_MESSAGE_END` ·
`REASONING_MESSAGE_CHUNK` · `REASONING_END` · `REASONING_ENCRYPTED_VALUE`

All events share `type`, `timestamp?`, `rawEvent?`.

**A documentation trap worth flagging:** <https://docs.ag-ui.com/concepts/events>
names every event in PascalCase (`TextMessageContent`) — that is the *class*
name. The `type` string on the wire is `TEXT_MESSAGE_CONTENT` `[V, measured]`.
Anyone reading only the docs will write a broken client. (The README's "~16
standard event types" is likewise a fossil of the 2025 design — and is exactly
the set frozen into the incomplete protobuf schema.)

The five `THINKING_*` events are **deprecated but still shipped**, superseded
by `REASONING_*`; the JSDoc says "Will be removed in 1.0.0" `[V]`. `MetaEvent`
is documented as DRAFT but **exists in neither shipped SDK** `[V]`. The drafts
index describes its contents as "under internal review" — a telling phrase for
an open standard.

There is a client-side ordering validator (`packages/client/src/verify/`)
enforcing that the first event is `RUN_STARTED`, that nothing follows
`RUN_ERROR`, and that `RUN_FINISHED` cannot arrive while steps, messages or
tool calls are open. That is the closest thing to a conformance suite, and it
validates only *inbound* streams `[V]`.

Also present in the package and relevant to us `[V]`:
`Interrupt{id, reason, message, tool_call_id, response_schema, expires_at,
metadata}`, `RunFinishedInterruptOutcome`, `ResumeEntry{interrupt_id, status,
payload}`, `AgentCapabilities{identity, transport, tools, output, state,
multi_agent, reasoning, multimodal, execution, human_in_the_loop, custom}`, and
multimodal input parts (`ImageInputContent`, `AudioInputContent`,
`DocumentInputContent`, `BinaryInputContent`).

Caveat on `AgentCapabilities`: it looks impressive but is an **optional SDK
method** `getCapabilities?()` that `HttpAgent` does not implement, and the .NET
docs state outright that *"the AG-UI specification does not prescribe how
capabilities are exposed over the wire."* Several of its flags advertise
features with no mechanism behind them `[V]`.

### 2.6 What AG-UI does not cover

Important framing correction: **AG-UI states no non-goals.** A search of the
whole corpus for "non-goal" / "out of scope" / "not in scope" returns zero
hits; the introduction instead calls AG-UI the *"kitchen sink"* protocol `[V]`.
So the gaps below are *absences under active discussion*, not declared
exclusions — which cuts both ways for us (§6.3).

| Concern | Status as of 2026-08-07 `[V]` |
|---|---|
| **Evaluation / judging** | **Never mentioned. Zero hits anywhere in docs or SDKs.** No verdict type, no score, no rubric. The most total gap — and the centre of our product. |
| **Versioned prompts / instructions** | **Never mentioned. Zero hits.** Only raw `system`/`developer` messages and `context: [{description, value}]`. |
| **Persistence / thread history** | Not covered. `threadId` is a required, opaque, client-supplied string with no operations behind it. Maintainer position (discussion #1160, answered 2026-05-26): *"this is application state, not AG-UI core."* Open: #1454 (server-minted ids), #2159 (pagination), #2186 (the client resends the **entire** message array every run). |
| **Cost / trace observability** | **Not shipped.** Zero occurrences of usage/token/cost/otel/span in either SDK's core event and type files. Token counts are an **open, unmerged PR** — #2188, adding `usage?: TokenUsage[]` to `RUN_FINISHED`/`RUN_ERROR`, **changes requested by the maintainer 2026-08-06** — and it carries counts only, **no currency or spend field**. No trace or span id on any event; issue #2019 documents Mastra trace ids being silently dropped across the boundary. |
| **Replay / rewind** | Not covered, and structurally blocked by the absence of sequence numbers (#2105). Rewind/edit/regenerate is currently *inferred* by integrations diffing the inbound `messages` array against their own history; standardising it is open at #2154. |
| **Background / detached runs** | **Reserved and hollow.** `pushNotifications` and `resumable` are advertised capability booleans with no wire contract (#2106, #2105). Long-running tool calls have been open since **2025-07-18** (#200); a proposed `longRunning` flag never landed. |
| **Auth / identity** | Entirely delegated to HTTP headers. `RunAgentInput` has no user or tenant field. No security page exists in the docs. |
| **Multi-agent / tool discovery** | Partial: `parentRunId` plus declarative capability flags. No handoff event, no routing event, no addressing scheme. Defers to A2A via an **experimental** `@ag-ui/a2a` bridge and to MCP via optional middleware; neither is in core. |

**Where AG-UI is actually heading in H2 2026** `[V, discussion #2161 and
umbrella issue #2162, both 2026-07-10]`: ~8-9 items — rewind, push
notifications, resumability, client→server custom actions, paginated history,
incremental message sync, surface tool registration, token usage. A maintainer
confirmed on 2026-07-21 that *"none of these eight are shipped… they're all
genuine open design decisions."* Note what is **not** on that list: evaluation,
judging, versioned instructions, cost. Meanwhile the 18 issues actually
labelled `Roadmap` are almost entirely **ecosystem breadth** (Elixir SDK, Swift
SDK, n8n, Langflow, React Native), not protocol capability.

---

## 3. Mapping table

### 3.1 AG-UI → Cupel

| AG-UI event | Our equivalent | Semantic gap |
|---|---|---|
| `RUN_STARTED {threadId, runId, parentRunId?, input?}` | `event: task` → `ChatTaskEvent` (`openapi.yaml:2414`) | `runId→task_id`, `threadId→conversation_id` map cleanly. **`user_turn_id` and `assistant_turn_id` have no AG-UI source** — the adapter mints them client-side, so they are not server identities and cannot be used with `POST /feedback` (`message_id = Turn.id`) or `GET .../turns/{turnId}/trace`. |
| `TEXT_MESSAGE_START {messageId, role}` | — | No per-message start in our contract. `messageId` is the closest thing to a `Turn.id`, but it arrives *after* we've had to emit `task`. |
| `TEXT_MESSAGE_CONTENT {messageId, delta}` | `event: token` → `TokenEvent {delta}` (`openapi.yaml:2424`) | Clean 1:1 — **the only clean mapping in the table.** Our `TokenEvent` has no `messageId`, so interleaved messages (sub-agents) collapse into one text stream. |
| `TEXT_MESSAGE_END`, `TEXT_MESSAGE_CHUNK` | — / `token` | `END` dropped; `CHUNK` folds into `token`. |
| `RUN_FINISHED {threadId, runId, result?, outcome?}` | `event: done` → `ChatDoneEvent {turn, status}` (`openapi.yaml:2430`) | **`RUN_FINISHED` carries no Turn.** No `author`, `created_at`, `content_type`, `attachments`, `envelope`. All must be reconstructed by the adapter from accumulated deltas + the client clock. `outcome` can be an interrupt, which our `status` enum (`completed`\|`cancelled`) cannot express. |
| `RUN_ERROR {message, code?}` | `event: error` → `Error` | Close. But our contract says `done` is **always** sent, even on stop-generation (`openapi.yaml:2433`); AG-UI's terminal on abort is a client-synthesised `RUN_ERROR`, not a `cancelled` done. |
| `STEP_STARTED` / `STEP_FINISHED {stepName}` | closest: `SpanEvent` on `/tasks/stream` (`openapi.yaml:2859`) | Name only. No `id`, `parent_id`, `type`, `start`/`end`, `tokens_in/out`, `cost`, `model`, `payload_ref`. **Cannot populate `Span` (`openapi.yaml:2726`) or `Trace.totals`.** Wrong channel too — trace spans explicitly do not stream on `/chat` (`openapi.yaml:880`). |
| `TOOL_CALL_START/ARGS/END/RESULT` | `Span{type: tool}` + `SpanPayload{args,result}` | Structurally the closest AG-UI gets to a span: `toolCallId`→`span.id`, `toolCallName`→`span.name`, `ARGS` deltas→`payload.args`, `RESULT.content`→`payload.result`. **No timing, no cost, no parent link.** Requires client-side buffering and a synthesised `payload_ref`. |
| `THINKING_*`, `REASONING_*` | — | We have **no** reasoning surface. Pure gain if we build one. |
| `STATE_SNAPSHOT` / `STATE_DELTA` (JSON Patch) | — | No concept. Nearest neighbour is the tree memory doc (`GET/PUT /agenttrees/{tree}/memory`), but that is persisted-per-tree, not per-run shared state. |
| `MESSAGES_SNAPSHOT {messages}` | closest: `GET .../conversations/{id}` `.turns` | Different lifecycle: ours is a REST read; theirs is a mid-stream authoritative rewrite of history. |
| `ACTIVITY_SNAPSHOT` / `ACTIVITY_DELTA` | `TaskProgressEvent {task_id, progress{done,total,stage}}` (`openapi.yaml:2852`) | Loose. Activity is free-form typed content; progress is a counter + stage label. Would need a private `activityType` convention. |
| `CUSTOM {name, value}` | — | **The extension point.** Everything Cupel-specific (envelope, span, judgment, progress) would have to ride here — i.e. we'd be inventing a private protocol inside a public one. |
| `RAW {event, source?}` | — | Passthrough; no use. |

### 3.2 What AG-UI has NO concept of

| Ours | Where | Why AG-UI can't carry it |
|---|---|---|
| **`ContextEnvelope` captured at generation** | `openapi.yaml:2220-2232`, `Turn.envelope` `:2278` | No field anywhere. Only carrier is `Context[]` (untyped `{description,value}`) inbound and `CUSTOM` outbound. Inbound-only echo is a *weaker* guarantee than "captured at generation, never reconstructed" (feature-spec.md:76). `[V — prototype had to echo the client-supplied envelope]` |
| **`client_message_id` idempotency** | `openapi.yaml:2357` | `runId` exists but retry-with-same-`runId` is undefined behaviour. Carrier: `forwardedProps`, by private convention. `[V]` |
| **Parent/child task model, cancel-cascade, retry-failed** | `Task.parent_id` `openapi.yaml:2784`, `DELETE /tasks/{id}` `:1241`, `/retry-failed` `:1255` | `parentRunId` exists for sub-agents, but there is no queue, no out-of-band task list, no cancel verb, no retry. |
| **Server-authoritative cancellation** | `openapi.yaml:875-877, 1241-1253` | The only lever is aborting the HTTP request `[V]`. Lost: cancelling from a *different* connection/tab/device; a `cancelled` terminal status; **persistence of the partial turn** (our contract says the partial content "IS persisted"). |
| **`stream: false` JSON mode** | `openapi.yaml:883-888` | AG-UI is stream-only. |
| **Run/cell grid** | `POST /replay`, `GET /runs/{id}` | Absent entirely. |
| **Append-only judgments** | `POST /feedback`, `/eval/judge`, `JudgmentEvent` `openapi.yaml:2867` | Absent entirely. |
| **Cost/trace** | `Span.tokens_in/out/cost/model`, `Trace.totals` | Absent; `STEP_*` has no cost. |
| **Conversation persistence at all** | `conversations` tag (4 ops), fork `Lineage`, `origin`/`channel`, soft delete | Absent. `threadId` is an identifier, not a store. |

### 3.3 What WE have no concept of

| AG-UI | Verified surface | Our position |
|---|---|---|
| **Frontend tool calls / generative UI** | `RunAgentInput.tools: list[Tool]` + `TOOL_CALL_*` `[V]` | Nothing. This is AG-UI's headline feature and we cannot express it. |
| **Shared bidirectional state** | `RunAgentInput.state` + `STATE_SNAPSHOT`/`STATE_DELTA` `[V]` | Nothing. |
| **Human-in-the-loop interrupts** | `Interrupt`, `RunFinishedInterruptOutcome`, `RunAgentInput.resume[ResumeEntry]` `[V]` | Nothing. Our `ChatDoneEvent.status` enum has no "waiting" state. |
| **Reasoning / thinking stream** | 9 event types `[V]` | Nothing. |
| **Sub-agents** | `parentRunId`, `SubAgentInfo` `[V]` | We have parent/child *tasks* but not nested agent runs inside one chat turn. |
| **Multimodal input parts** | Image/Audio/Document/Binary `InputContent` `[V]` | We have `/upload` + `Attachment` ids only. AG-UI is richer here. |
| **Capability negotiation** | `AgentCapabilities` (11 groups) `[V]` | We have `GET /settings` and `GET /models`, no per-agent capability doc. |

---

## 4. Prototype

Location (outside the repo, as instructed):
`C:\Users\soura\AppData\Local\Temp\claude\C--Users-soura\715403df-aa63-4d19-bf0b-ee44cb39d8f7\scratchpad\agui\`

- `server.py` (117 lines) — minimal AG-UI agent: FastAPI `POST /awp` taking
  `RunAgentInput`, returning `StreamingResponse` of `EventEncoder`-encoded
  events. No LLM; a canned reply is streamed token-by-token so ordering is
  assertable. `?mode=slow` for cancellation, `?mode=error` for `RUN_ERROR`.
  Plus `GET /introspect/{run_id}` reporting whether the server noticed the
  client hang up.
- `sse.ts` — **verbatim copy of `src/api/sse.ts`**, so the framing layer under
  test is our real one.
- `adapter.ts` (255 lines total, **201 non-comment non-blank**) — translates
  the AG-UI stream into `ChatSendResult`-shaped output identical to
  `src/api/client.ts:197`.
- `test.ts` (97 lines) — assertions.
- `negative.ts` — proves the unmodified consumer fails.

Toolchain: Python 3.13.12 + `ag-ui-protocol==0.1.19`, `fastapi==0.141.1`;
Node v24.15.0 running `.ts` directly via native type stripping. Everything
below was **executed** `[V]`.

### 4.1 Result: 17/17 checks passed

```
PASS  first event is `task` — task,token,token
PASS  terminal event is `done`
PASS  exactly one terminal event
PASS  tokens arrive in order and reassemble — "Hello, this is an AG-UI agent."
PASS  done.status == completed
PASS  done.turn.content == concatenated tokens
PASS  done.turn.envelope present
PASS  task carries all 4 required ids
PASS  RUN_ERROR maps to `error` frame
PASS  error carries code+message
PASS  no `done` after `error`
PASS  abort yields a `done` frame
PASS  done.status == cancelled
PASS  partial tokens retained (>0) — 5 tokens
PASS  partial content on the cancelled turn
      server introspect: {"produced":5,"disconnected":true,"known":true}
PASS  server observed the disconnect (transport-level only) — produced=5 vs client saw 5
```

### 4.2 The negative result that matters

```
frames parsed by src/api/sse.ts: 12
distinct SSE event: names seen: ["message"]
frames chatEvents() would emit: 0
```

Our framing parser is compatible; our *consumer* is not. `chatEvents()`
(`src/api/client.ts:201`) switches on the SSE `event:` name; AG-UI never sets
one. So "point Cupel at an AG-UI backend" can never be a `baseUrl` change — it
is always code.

### 4.3 What worked, and how much code

The translation is genuinely easy at the token level. `RUN_STARTED → task`,
`TEXT_MESSAGE_CONTENT → token`, `RUN_FINISHED → done`, `RUN_ERROR → error` is
about 40 lines of switch. **The other ~160 lines are all synthesis of things
AG-UI doesn't send**: minting turn ids, accumulating content into a `Turn`,
echoing an envelope, manufacturing a terminal `done` when the stream just ends,
and converting an `AbortError` into `status: cancelled`.

That ratio — 1 part translation to 4 parts fabrication — is the spike's central
measurement.

### 4.4 What did not work, honestly

- **Cancellation is transport-only.** The abort works and the UI would behave
  correctly `[V]`. But the server learns about it via `request.is_disconnected()`,
  not a protocol message. Three things our contract promises are simply
  unobtainable and I did not pretend otherwise in the test — the script prints
  them as "not provable":
  - server-side persistence of the partial cancelled turn;
  - idempotent replay of a `client_message_id`;
  - a `task_id` usable with `DELETE /tasks/{id}` **from another connection**
    (`openapi.yaml:1241`) — our runId is only meaningful to the socket holding it;
  - envelope captured *at generation* rather than echoed from the client.
- **`done.turn.envelope present` passes, but it's a lie by construction.** The
  adapter echoes back the envelope the client sent. It satisfies the schema and
  violates the invariant (`feature-spec.md:76`, "captured at generation, never
  reconstructed"). I kept the check in the suite specifically so the doc can
  point at it.
- **No trace.** I did not attempt `STEP_*`/`TOOL_CALL_*` → `Span` because
  `Span` requires `start`, `end`, `status` and `payload_ref`, none of which
  exist in the AG-UI events. It would be pure invention `[I]`.
- I did **not** run our React UI against the adapter (out of scope per the
  brief), so "ChatPage renders correctly" is `[I]`, not `[V]`.

---

## 5. The three answers

### (a) How many of our 69 operations would an AG-UI-native adopter no longer need to implement?

**One.** `chat` (`openapi.yaml:855`).

Operation counts by tag (`[V]`, extracted from `openapi.yaml`): auth 2,
identity 1, admin 8, meta 2, trees 3, agents 7, conversations 4, memory 4,
**chat 3**, runs 4, trace 2, tasks 5, eval 13, casebooks 9, settings 2 = 69.

Of the chat tag: `chat` is covered; `upload` is not (AG-UI carries multimodal
content inline but defines no upload endpoint); `postFeedback` is not.

**What remains: 68.** Including, for a *chat-only* deployment, still all of:
`createToken`, `getMe`, `listAgentTrees`, `listConversations`, `getConversation`,
`updateConversation`, `deleteConversation`, `listModels`, `upload`,
`postFeedback` — because AG-UI gives you a run, not a store. So even the
minimum viable Chat page needs ~9 operations, of which AG-UI supplies 1.

And the framework builder's actual pain is the other end: eval 13 + casebooks 9
+ runs 4 + trace 2 + tasks 5 + agents 7 = **40 studio operations** that AG-UI
does not touch at all. Adopting AG-UI in the client removes 1.4% of the
integration surface and none of the hard part.

Caveat `[I]`: an adopter on LangGraph or Mastra may get thread persistence from
their *framework's* checkpointer, which would make `listConversations` /
`getConversation` cheaper to implement. That is a framework benefit, not an
AG-UI one — AG-UI defines no wire for it.

### (b) What do we lose or have to reinvent, and is each loss survivable?

| Loss | Severity | Survivable? How |
|---|---|---|
| **`ContextEnvelope` at generation** | High — it's a named invariant | **Yes, only server-side.** A bridge stamps it at generation exactly as the mock does today. In a client-side adapter it degrades to a client echo, which fails `feature-spec.md:76` and quietly poisons replay fidelity (Phase 1 replays run under the frozen envelope, `openapi.yaml:2226`). **Not survivable in the client.** |
| **`client_message_id` idempotency** | Medium | **Yes**, via `forwardedProps.clientMessageId` `[V, prototype]` — but the AG-UI server must be taught to honour it, so it's a private convention, not interop. A bridge honours it centrally and the adopter never sees it. |
| **Parent/child task model, cancel-cascade, retry-failed** | Low for chat, fatal for studio | **Yes for chat** — one in-flight run, `runId ≈ task_id`. **No for replay/judge batches**, which are inherently multi-run and have no AG-UI representation. A bridge owns the queue and calls AG-UI N times. |
| **Server-authoritative cancellation + persisted partial** | Medium | **Partly.** Aborting works `[V]`; the *user experience* of stop-generation survives. Lost: cross-connection cancel, and the partial turn's persistence. A bridge restores both (it holds the socket and the DB). A client adapter cannot. |
| **`stream: false` JSON mode** | Low | **Yes** — a bridge buffers the AG-UI stream and returns JSON. Free. |
| **Trace / cost** | High for our differentiation | **Partly.** `STEP_*`+`TOOL_CALL_*` give structure but no timing, no cost, and **no trace or span id on any event** `[V]`. A bridge can add wall-clock timing itself but must get tokens/cost from the provider, not from AG-UI — token usage is still an unmerged PR with changes requested (#2188, 2026-08-06) and carries **no spend field** even if merged. Expect degraded traces against AG-UI backends and say so in the UI. |
| **Judgments, runs, versions, casebooks** | n/a | Not lost — AG-UI never claimed them. They stay in our contract. |

Summary: **every loss is survivable in a bridge and roughly half are not
survivable in a client adapter.** That asymmetry is the whole argument.

### (c) Adapter in the client, a mode in `agentic.config.ts`, or a contract rewrite?

**None of the three as posed. Build a bridge — but wire it through the config
hook that already exists.**

`agentic.config.ts` already declares the right seam:

```ts
adapter?: string;   // agentic.config.ts:60 — "Declared + typed now; not consumed yet"
```

with the comment citing `cupel-phases.md:75`: *"any backend at all via a small
adapter module — with the mock filling in whatever your backend doesn't do
yet."* The spike's conclusion is that the correct reading of that line is
**server-side**.

**Shape I'd actually build:**

1. **`cupel-agui-bridge`** — reuse `mock/`. There is exactly one seam:
   `mock/engine.py:305 chat_events()` calls `llm.stream(...)` at `:326`, an
   `async def stream(...) -> AsyncIterator[str]` (`mock/llm.py:107`). Add
   `mock/agui.py` exposing the same signature, posting `RunAgentInput` to a
   configured AG-UI URL and yielding `TEXT_MESSAGE_CONTENT` deltas. Everything
   else the mock already does — conversation creation, envelope stamping,
   turn persistence, task registration, cancellation via
   `self.is_cancelled(task_id)` (`mock/engine.py:328`), span emission via
   `_emit_trace`, `/tasks/stream` fan-out — keeps working unchanged.
   **Estimate: 200-350 LOC** for the client + config + tests. This is small
   because the mock is already the shape of the answer.
2. **Span enrichment** — map `STEP_*` and `TOOL_CALL_*` into real `Span` rows
   inside the bridge, where wall-clock timing is available.
   **Estimate: 150-250 LOC.** Optional; ship without it first.
3. **`agentic.config.ts`**: no new `target.protocol` field. The bridge is just
   another `BackendTarget` with a `baseUrl`. Zero config-surface growth —
   which preserves the one-config-artifact invariant.
4. **`cupel-ready`**: the bridge reports full conformance by construction, so
   `npm run ready` against it passes. That is the adopter's onboarding proof.
5. **Docs**: "you have an AG-UI agent → run the bridge → you have a console" as
   the framework-builder quickstart.

**Total estimate: ~400-600 LOC and roughly 1-2 weeks**, versus the client-adapter
path which I measured at 201 LOC for chat alone and which produces a
non-shippable product (no history).

Explicitly **rejected**:
- *Client adapter / `target.protocol: cupel | agui`* — 201 LOC `[V]` for a chat
  widget with no persistence, no trace, no replay, and an envelope that lies.
  It also forks `src/api/client.ts` into two protocol paths, which collides with
  "ALL calls go through `src/api/client.ts`" and with the MSW parity test
  (`src/test/msw/parity.test.ts`).
- *Rewriting the contract's chat half in AG-UI events* — would mean adopting a
  pre-1.0 schema with no versioned spec document (§2.2) into a document we ask
  third parties to implement, while losing the write semantics that make chat a
  console feature rather than a widget.

**Worth doing regardless of the AG-UI decision** (these are gaps AG-UI merely
exposed): human-in-the-loop interrupt states in `ChatDoneEvent.status`, a
reasoning/thinking surface, and frontend tool calls. Those are real product
holes and AG-UI's taxonomy is a good free design review of our contract.

---

## 6. Risks

### 6.1 The strongest argument against my own recommendation

**"Bridges lose."** Protocol history says the thing that wins is the thing you
can point at directly. A framework builder with a Mastra agent wants
`baseUrl = my-agent-url` and a UI. "Run our Python bridge alongside your agent"
is an extra process, an extra deploy, an extra thing to debug, and an extra
place for our SQLite to be the wrong answer for their infrastructure. Meanwhile
CopilotKit ships `npx create-ag-ui-app` and they have a UI in 60 seconds `[V,
README]`. If AG-UI becomes the assumed interface, "Cupel requires a bridge"
reads as "Cupel doesn't support AG-UI", and no amount of architectural
correctness fixes that perception.

There is a real version of this critique that I take seriously: we could ship
**both** — the bridge as the supported path, *and* a thin client adapter behind
a loud "chat-only, nothing is persisted" degradation banner, purely as a
60-second demo that converts. That doubles the maintenance and I would not do
it in the first pass, but it is the honest counter-proposal.

### 6.2 What would change my mind

These are concrete and watchable — most have an issue number to subscribe to:

- **Paginated history / persistence lands** (#2159, #2186, and the position in
  discussion #1160 reversing). If AG-UI defines listing threads and reading
  history, the client-adapter path becomes viable and the bridge becomes
  redundant for the chat half. **This is the single highest-signal thing to
  watch.**
- **Resumability + push notifications ship** (#2105, #2106). Today they are
  capability booleans with no wire contract; giving them one would restore
  cross-connection cancel and detached runs — two of my four "not survivable in
  the client" losses (§4.4).
- **Token usage merges with a spend field** (#2188 — currently changes-requested,
  counts only). Cost is load-bearing for our trace view; if AG-UI carries it,
  traces against AG-UI backends stop being second-class.
- **A neutral-foundation donation plus a 1.0 and a versioned spec document.**
  That removes the §2.2 objection and would justify aligning `openapi.yaml`'s
  chat event *names* to AG-UI even without changing transport.
- **Evidence that framework builders won't run a second process.** If we try
  the bridge with 3 design partners and the first objection is always "I'm not
  deploying another service", the calculus flips toward the thin client adapter
  plus honest degradation.

Conversely, one thing would *confirm* the recommendation rather than change it:
**evaluation appearing on the AG-UI roadmap.** It is currently a zero-hit search
across the entire corpus (§2.6) and absent from the H2 2026 list. If it shows
up, that is CopilotKit moving into our lane — and the bridge is exactly the
posture that lets us stay compatible without being downstream of them.

### 6.3 Strategic risk, stated plainly

**If we ride AG-UI, does CopilotKit's roadmap eat our differentiation?**

Partly — and crucially, **AG-UI declares no non-goals** (§2.6). It calls itself
the "kitchen sink" protocol, and there is no neutral body to stop it growing in
whatever direction CopilotKit's product needs, because it was pointedly *not*
donated to a foundation the way MCP and A2A were (§2.1).

The direction of travel is towards us. Token usage is an open PR (#2188);
`ACTIVITY_*`, `REASONING_*` and interrupts are observability-adjacent surfaces
that grow into traces. A company that just raised $27M (2026-05) needs to sell
something above a free MIT wire protocol, and the obvious somethings are a
hosted console, traces, and evals. If they ship eval, they ship it *with
distribution we do not have*.

The counterweight, and it is a real one: **evaluation is a zero-hit search
across the entire AG-UI corpus, and it is absent from the eight-item H2 2026
list** the maintainers published on 2026-07-10 `[V]`. That list is rewind, push
notifications, resumability, custom actions, paginated history, message sync,
tool registration, token usage — all *transport* concerns. As of today they are
building a better wire, not a studio.

But note what the bridge does to this risk: our differentiation is not the chat
stream, it is versioned instructions, replay/compare, LLM judge, casebooks and
cost traces — **40 of 69 operations**. Riding AG-UI for the token stream costs
us nothing there, because the token stream was never the moat. The moat is
whether a self-hosted, contract-defined studio beats a hosted one, and AG-UI is
orthogonal to that question. Speaking AG-UI at the edge makes us *compatible
with* the ecosystem's default wire without making us *dependent on* its
roadmap. That is a strictly better position than either extreme.

**If we don't, do we lose the framework-builder persona entirely?**

Not entirely, but we lose the *easy* ones. The persona splits:

- The builder who wants a UI in 60 seconds is already served by CopilotKit and
  was never ours — they don't want a studio, they want a chat window.
- The builder who wants *versioned instructions, replay against a changed
  config, and an LLM judge* has no AG-UI answer at all, and does not care what
  wire their tokens arrive on. That is our persona, and the wedge is the
  studio, not the transport.

The failure mode of declining outright is subtler than losing the persona: it's
being *invisible* to it. If every ADK/LangGraph/Mastra tutorial ends with "now
plug in an AG-UI frontend", we're not in that sentence. The bridge puts us in
it. That is why the recommendation is adopt-**partially** and not decline.

---

## Sources

Protocol and ecosystem (all fetched 2026-08-07 unless noted):

- AG-UI docs — <https://docs.ag-ui.com/>
- AG-UI repo README — <https://github.com/ag-ui-protocol/ag-ui>
- AG-UI event types reference — <https://docs.ag-ui.com/concepts/events>
- ag-ui issue #880, "RUN_ERROR event missing required 'message' field on
  AbortError" (opened 2025-12-29, closed) —
  <https://github.com/ag-ui-protocol/ag-ui/issues/880>
- CopilotKit AG-UI docs — <https://docs.copilotkit.ai/agentic-protocols/ag-ui>
- CopilotKit $27M raise, 2026-05-05 — TechCrunch
  <https://techcrunch.com/2026/05/05/copilotkit-raises-27m-to-help-devs-deploy-app-native-ai-agents/>;
  GeekWire
  <https://www.geekwire.com/2026/seattles-copilotkit-raises-27m-as-some-of-the-biggest-names-in-tech-adopt-its-ai-agent-protocol/>;
  CopilotKit's own post <https://www.copilotkit.ai/blog/series-a>
- Oracle AG-UI / A2UI integration announcement —
  <https://blogs.oracle.com/ai-and-datascience/announcing-agent-spec-for-a2ui-copilotkit-ag-ui>
- CopilotKit, "Master the 17 AG-UI Event Types" —
  <https://www.copilotkit.ai/blog/master-the-17-ag-ui-event-types-for-building-agents-the-right-way>
  (note: the taxonomy has since grown to 33 types — §2.5)
- PyPI `ag-ui-protocol` release metadata — <https://pypi.org/pypi/ag-ui-protocol/json>
- npm `@ag-ui/core` registry metadata — <https://registry.npmjs.org/@ag-ui/core>
- SDK source read on `main`: `sdks/typescript/packages/core/src/types.ts`
  (`RunAgentInput`), `.../client/src/transform/sse.ts` (SSE parser — "Non-data
  fields (event, id, retry) are ignored"), `.../client/src/transform/http.ts`
  (protobuf path), `.../client/src/verify/` (ordering validator),
  `sdks/python/ag_ui/encoder/encoder.py`, `sdks/typescript/packages/proto/src/proto/events.proto`
- `integrations/server-starter/python` — the reference minimal server
- Interrupts concept doc — <https://docs.ag-ui.com/concepts/interrupts>
  (landed 2026-04-30, PR #1569)
- Open issues cited: #200 (long-running tools, 2025-07-18), #880 (abort,
  2025-12-29, closed), #1160 (persistence is "application state", answered
  2026-05-26), #1454, #1570 (request for a machine-readable schema, 2026-04-22),
  #2019 (trace ids dropped), #2105 (no resumption, 2026-07-02), #2106,
  #2154 (rewind), #2159, #2161 + #2162 (H2 2026 direction, 2026-07-10),
  #2186, #2188 (token usage PR, changes requested 2026-08-06)
- Microsoft Agent Framework AG-UI integration —
  <https://learn.microsoft.com/en-us/agent-framework/integrations/ag-ui/>
  (2026-07-10); PyPI `agent-framework-ag-ui` v1.0.1 (2026-07-23)
- AWS Open Source Blog, "Open protocols with the Strands Agents SDK"
  (2026-07-16) — the AG-UI integration is community, not AWS-supported
- Linux Foundation, Agentic AI Foundation formation (2025-12) —
  <https://www.linuxfoundation.org/press/linux-foundation-announces-the-formation-of-the-agentic-ai-foundation>
- Primary evidence for §2.3-2.5 is the installed `ag-ui-protocol==0.1.19`
  package plus the SSE bytes I captured, not documentation.

**Could not be established** (stated plainly rather than guessed):

- The GitHub Projects roadmap board is **not publicly readable** — the
  label/issue survey in §2.6 is a substitute, not the board.
- **Whether the AG-UI Working Group has ever met.** The Luma calendar is empty
  and no minutes exist publicly.
- Org membership — the members API returns empty, so commit rights are inferred
  from CODEOWNERS and commit volume.
- **No independent critical analysis of AG-UI appears to exist.** Searches for
  criticism returned almost exclusively CopilotKit-authored material — itself a
  signal about how much of the discourse the vendor controls, and a reason to
  weight this document's own first-hand measurements above its citations.
- I did not run our React UI against the adapter (out of scope), so
  "ChatPage renders correctly" remains `[I]`.

Our code:

- `openapi.yaml:855-926` (chat), `:1183-1219` (`/tasks/stream`), `:1221-1253`
  (task get/cancel), `:1255-1268` (retry-failed), `:2220-2232`
  (`ContextEnvelope`), `:2244-2290` (`Turn`), `:2349-2404` (`ChatRequest`),
  `:2414-2440` (chat SSE events), `:2726-2760` (`Span`), `:2784-2851` (`Task`),
  `:2852-2874` (task stream events)
- `src/api/sse.ts:26` (`createSseParser`), `:99` (`parseSseStream`)
- `src/api/client.ts:174` (`ChatStreamEvent`), `:197` (`ChatSendResult`),
  `:201` (`chatEvents`), `:429` (`chat`), `:534` (`taskStream`)
- `agentic.config.ts:52` (`remap`), `:60` (`adapter`), `:75` (Cupel stores
  nothing server-side)
- `mock/engine.py:305` (`chat_events`), `:326` (`llm.stream` seam),
  `mock/llm.py:107` (`stream` signature)
- `cupel-phases.md:75` ("any backend at all via a small adapter module — with
  the mock filling in whatever your backend doesn't do yet")
- `docs/readiness.md` (`cupel-ready` conformance tool)
