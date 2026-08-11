# Why Cupel doesn't speak AG-UI yet

If you build agents on ADK, LangGraph, Mastra, Pydantic AI or Agno, there's a
good chance the last line of the tutorial you followed was "now plug in an
AG-UI frontend." So it's a fair question to ask of us: *why can't I point Cupel
at my AG-UI endpoint?*

The honest answer is not "AG-UI is bad." We spent a week reading its source,
standing up a server, and writing a working adapter against it. AG-UI is small,
clean, genuinely well designed, and it is winning. The answer is that it solves
a different problem than the one our chat endpoint solves, and the gap between
them has to be filled by *somebody* — and today that somebody would have to be
you.

We expect this to change. More on that at the end.

## What AG-UI is

AG-UI — the Agent-User Interaction Protocol — standardises how an agent talks to
a user-facing app. It sits alongside MCP (agent↔tools) and A2A (agent↔agent) as
the agent↔UI piece. You POST a `RunAgentInput` and get back an SSE stream of
typed events: `RUN_STARTED`, `TEXT_MESSAGE_CONTENT`, `TOOL_CALL_START`,
`RUN_FINISHED`, and about thirty more.

It's a good design. The event taxonomy is thoughtful, the tool-call and
shared-state events enable genuinely nice things (generative UI, human-in-the-loop
interrupts), and the adoption is real — Microsoft's integration is first-party
and marked Production/Stable, and Pydantic AI, Agno and LlamaIndex ship it in
core.

## The short answer

Two facts, one structural and one arithmetic.

> **Our `POST /agenttrees/{tree}/chat` is a write. AG-UI's run endpoint is a
> pure function call.**

Our chat endpoint doesn't just stream tokens. It creates a conversation, appends
a user turn, stamps a context envelope *at the moment of generation*, mints a
server-authoritative task id you can cancel from a different tab, persists the
partial turn if you hit stop, and emits trace spans on a separate channel for
the cost view.

AG-UI defines none of that, and says so — a maintainer's position on thread
persistence is that it's "application state, not AG-UI core." It defines a
stateless call: input in, event stream out.

That matters because Cupel is a pure client. Your backend holds all persistence;
Cupel itself stores nothing server-side. So an AG-UI adapter *in our client*
produces a chat widget with no history, no replay, no judgments and no traces.
That isn't the product.

The second fact is arithmetic. AG-UI covers the wire format of **one** of the
contract's 67 operations — chat itself. Not `upload`, not `postFeedback`. And
the expensive part of integrating was never the chat endpoint: it's the 37
studio operations — versioned instructions, replay, the comparison grid, the
judge, traces, the task queue — that AG-UI has no opinion about at all.

Even a minimum viable chat page still needs roughly nine operations, of which
AG-UI supplies one. Speaking AG-UI in the client would remove about 1.4% of the
integration surface and none of the hard part, while costing us the envelope,
idempotency, server-side cancellation and the entire persistence layer.

## We measured this rather than assumed it

We built the adapter to find out. The translation layer works: 17 of 17
behavioural checks passed — tokens arrive in order and reassemble, abort yields
a `cancelled` terminal event, partial content is retained, `RUN_ERROR` maps
cleanly onto our error frame.

Two results from that exercise are worth repeating.

**The adapter is one part translation to four parts fabrication.** Mapping
`RUN_STARTED → task`, `TEXT_MESSAGE_CONTENT → token`, `RUN_FINISHED → done` is
about 40 lines of switch statement. The other ~160 lines are all *inventing
things AG-UI doesn't send*: minting turn ids, accumulating deltas into a turn,
manufacturing a terminal event when the stream simply ends, and echoing back an
envelope.

That last one is the tell. Our test asserts `done.turn.envelope present` and it
passes — but it passes by construction, because the adapter echoes the envelope
the client sent. It satisfies the schema and violates the invariant, which is
that the envelope is captured at generation and never reconstructed. We left
that check in the suite specifically so we couldn't forget it was a lie.

**"Point Cupel at an AG-UI backend" can never be a config change.** AG-UI puts
its discriminator in the JSON body (`"type": "TEXT_MESSAGE_CONTENT"`) and never
sets the SSE `event:` field. Our framing parser handles the stream fine — 12
frames — but our consumer switches on the event name, so it would emit exactly
zero. It's always code, never a `baseUrl`.

## It isn't a specification yet

This is the part that gives us most pause, and it's the most likely thing to
change.

There is no protocol version number — not in the docs, not in `BaseEvent`, not
in any header. There is no spec document: the normative artifact is a Zod schema
in `@ag-ui/core`, hand-mirrored into Python, .NET, protobuf and a handful of
community SDKs. A request for a machine-readable JSON Schema of the event types
has been open since April. Releases are date-tagged (`release/2026-08-04`) with
no protocol changelog, and neither SDK has reached 1.0.

Governance is single-vendor. `CODEOWNERS` is one line assigning everything to
CopilotKit; there is no charter, TSC, CLA or RFC process; roughly 80% of top
contributor commits are CopilotKit payroll; and unlike MCP and A2A, AG-UI has
not been donated to a neutral foundation.

None of that makes AG-UI unusable. It makes it a bad thing to put *inside*
`openapi.yaml` — a document we ask third parties to implement. We'd be making
our contract downstream of an unversioned file owned by one company. Speaking it
at the edge costs us nothing if it churns.

## Why we expect to support it eventually

We think the odds are good that this section becomes obsolete, and we'd be happy
about that.

CopilotKit raised **$27M** — a $20.5M Series A led by Glilot Capital Partners
with NFX, SignalFire and 97212 Ventures, on top of a $6.5M seed — announced in
May 2026, and named "further developing AG-UI as an open industry standard" as a
use of funds. Development is vigorous: a hundred commits in the week we looked.
The maintainers published an eight-item direction for H2 2026 covering rewind,
push notifications, resumability, paginated history, incremental message sync
and token usage.

Read that list again: **it is largely the list of things whose absence is our
objection.** Paginated history and message sync are the persistence gap.
Resumability and push notifications are the cross-connection cancel and detached
run gap. Token usage is the cost gap. A protocol with money, adoption and that
roadmap is a protocol we expect to be able to support properly — not through a
translation layer that fabricates four lines for every one it converts.

So: not "no." **Not yet**, and here is precisely what we're watching.

## What would change our mind

Each of these is concrete and has an issue number to subscribe to:

- **Paginated history and persistence land.** If AG-UI defines listing threads
  and reading history, the client-adapter path becomes viable and the whole
  objection above weakens dramatically. This is the single highest-signal thing
  to watch.
- **Resumability and push notifications ship a wire contract.** Today they are
  capability booleans with nothing behind them. Giving them one restores
  cross-connection cancellation and detached runs.
- **Token usage merges — with a spend field.** It's currently an open PR
  carrying counts only. Cost is load-bearing for our trace view.
- **A neutral-foundation donation, a 1.0, and a versioned spec document.** That
  removes the objection above entirely, and would justify aligning our chat
  event *names* to AG-UI even without changing transport.

## What we'd build when we do

Not a client adapter. A **bridge**: a small server that implements the Cupel
contract and proxies its generation call to any AG-UI endpoint, persisting
turns, envelopes, tasks and spans in its own store.

We already ship most of it. The bundled mock backend has exactly one seam —
`mock/engine.py`'s `chat_events()` calls `llm.stream(...)`, an
`async def stream(...) -> AsyncIterator[str]`. A module with the same signature
that POSTs `RunAgentInput` to a configured AG-UI URL and yields
`TEXT_MESSAGE_CONTENT` deltas would slot straight in, and everything else the
mock already does — conversation creation, envelope stamping at generation, turn
persistence, cancellation, span emission — keeps working untouched.

It needs no new config surface either: the bridge is just another
`BackendTarget` with a `baseUrl`, which preserves the one-config-artifact rule.
And `npm run ready` against it passes by construction, which is the adopter's
onboarding proof.

Estimated at 400–600 lines and one to two weeks, versus the client adapter we
measured at 201 lines for chat alone — which produces something we wouldn't want
to ship.

## The strongest argument against us

Bridges lose. The thing that wins is the thing you can point at directly. A
builder with a Mastra agent wants `baseUrl = my-agent-url` and a UI, and
"run our Python bridge alongside your agent" is an extra process, an extra
deploy and an extra thing to debug — while `npx create-ag-ui-app` gives them a
UI in sixty seconds.

If AG-UI becomes the assumed interface, "Cupel requires a bridge" reads as
"Cupel doesn't support AG-UI", and no amount of architectural correctness fixes
that perception. The honest counter-proposal is to ship both: the bridge as the
supported path, plus a thin client adapter behind a loud "chat only, nothing is
persisted" banner, purely as the demo that converts. We haven't done that
because it doubles the maintenance, but we don't think it's wrong.

## What we're fixing regardless

Reading AG-UI closely was a free design review, and it found three real holes in
our own contract that have nothing to do with whether we adopt it:

- **Human-in-the-loop interrupts.** Our chat-done status is `completed` or
  `cancelled`; there's no "waiting for the user" state. AG-UI models this
  properly with `Interrupt` and `resume`.
- **A reasoning surface.** AG-UI has nine event types for it. We have none.
- **Frontend tool calls.** Their headline feature, and we can't express it at
  all.

Those are product gaps we'd have found eventually and found sooner this way.

---

*Written after a week-long evaluation: reading the SDK source, running a
reference server, capturing the bytes on the wire, and building a working
adapter against our real SSE parser. Where we say something was measured, it was
measured. Where a claim about AG-UI's governance or roadmap is cited, it came
from the repository, the package registries or the maintainers' own posts rather
than from marketing material — for which there is, notably, no independent
critical analysis anywhere that we could find.*
