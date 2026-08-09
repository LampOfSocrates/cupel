# Plan — adopter onboarding: one command, cased by persona

Supersedes the generator half of `docs/plan-agentic-app-maker.md` and absorbs the hybrid
backend fill (#25). Written 2026-08-09 from the user's description of the intended flow.

## The flow, as described

1. Adopter clones this repo.
2. Runs one command → a `<name>-ui/` folder with everything needed to `npm run` the UI.
3. The command checks tech-stack availability first.
4. Adopter gets a chat UI and a studio UI.
5. On the same command they can point at their own backend's Swagger/OpenAPI.
6. We check it for compatibility and **ask them what to do about each mismatch**.
7. By default a bundled mock server serves whatever their backend does not.
8. They play with the UI, then want to integrate for real.
9. We give guided instructions for hooking up their agent tree.

## The one structural correction

**Ask per family, not per operation. APPROVED by the user 2026-08-09**, along with the
three-answer shape **mine / mock / hide**. A stranger's backend will match almost nothing —
the contract is 66 operations across 14 families, and the worked `cupel-ready --init`
example only reaches 37/66 because its remap was contrived for a backend already built to
this shape. A real first run is closer to 0–5 matched operations, which means 60+ questions
if we ask per endpoint.

**The family list is the contract's, not this document's** (2026-08-09, item 7 stage E): the
top-level `tags` of `openapi.yaml`, one per operation, read by `cupel-ready` and by the
generator's `--family <name>=mine|mock|hide`. Do not restate them here — they will drift.
Two corrections that cost this document its credibility on the point, kept as a warning: the
list it used to carry (chat · conversations · agents · instructions · evaluations · trace ·
tasks · eval workbench · casebooks · settings) named `instructions`, which the contract has
never tagged separately from `agents`, and OMITTED `memory`, which TASKS.md item 12 calls "the
last contracted but unbuilt family". Derived, the real count is fourteen — the ten above minus
`casebooks` (merged into `eval` in stage B) and minus `instructions`, plus `auth`, `identity`,
`admin`, `meta`, `trees` and `memory`.

Fourteen questions, not ten. Four of them are near-automatic for anyone who has an HTTP
backend at all (`meta`, `identity`, `auth`, `trees`), so the felt length is unchanged and the
questionnaire now covers the whole surface instead of 80% of it.

Three answers per family, and the third is the one that matters:

| answer | meaning |
|---|---|
| **mine** | mapped to their endpoints, with the prefix/auth remap `--init` already detects |
| **mock** | the bundled mock serves it; the UI shows a "served by mock" badge |
| **hide** | the UI for that family is not rendered at all |

`hide` is new and it is what makes the generated app feel like *their* product rather than
ours with holes in it. It is also how a studio-only adopter switches off chat entirely —
which is exactly the hypothesis #12 is meant to test, so this flow can test it for us.

**This answers Q4.** #25 (hybrid backend fill) is not a separate runtime feature; it is the
`mock` answer to a family question, resolved at generation time and written into the config.
What survives from #25 is the **badge** — cheap, and without it the adopter cannot tell which
half of the screen is real. Fold #25 into #21 and keep the badge.

## The decision that dominates the estimate: one mock or two

The bundled mock is Python/FastAPI + SQLite today (`mock/`). The user's flow says the
generated app ships a **Node** mock. That is right for the persona — a JS/TS agent developer
should not need Python 3.11 and a pip install to see the product — but it forces a choice,
and getting it wrong is expensive:

- **Two mocks** (keep Python for our suite, add Node for adopters) — **do not do this.** Two
  implementations of one contract drift immediately, and every contract change becomes two
  changes plus a conformance diff. This is the same duplication #14 exists to remove.
- **Port to Node and delete the Python mock** — one source of truth, no Python anywhere,
  adopters and our own e2e run the same server. Cost is real: SSE chat, evaluations, the task
  queue with parent/child cancellation, append-only versions/judgments/snapshots, the
  deterministic seed-42 generator, both auth modes, and s3/Litestream replication. Our entire
  e2e suite (13 journeys, both auth modes) and 160 pytest tests boot against it, so the port
  is verifiable — the suite is the acceptance test — but it is a multi-week task, not a
  sub-task of #21.
- **Ship the Python mock in the generated app** — free, and contradicts the flow's own
  tech-stack check by making Python a hard requirement for step 2.

**REVERSED 2026-08-09 (user): the Node port will never happen.** The Python mock stays.
What that costs, stated plainly so the on-ramp is honest about it:

- **Python 3.11+ is a hard prerequisite** for anything that ships the bundled backend, including
  the generated folder. The tech check at step 3 must say so up front rather than discovering it
  at first run — a JS/TS agent developer meeting a pip install is exactly the bounce this flow
  exists to prevent, and if we cannot remove it we must at least not surprise them with it.
- **Or the generated app ships no mock at all** and the `mock` answer to a family question means
  "point at a Cupel instance you run separately". That keeps the generated folder pure Node but
  makes `mine / mock / hide` mean something different — worth deciding deliberately rather than
  by default.

The one thing that remains non-negotiable either way: **one mock, not two.** A second
implementation in another language drifts from the contract immediately.

## Personas

| | who | what they have | what the command should do |
|---|---|---|---|
| **A** | evaluating the product | nothing | mock everything, seeded with realistic data. This is today's demo, and it must stay one command with no questions asked. |
| **B** | **the wedge** — an agent, no UI | a framework agent (ADK/LangGraph/Mastra/CrewAI/PydanticAI) reachable over HTTP; **usually no OpenAPI document at all** | cannot be served by swagger-matching. Needs the staged ladder below, starting from chat-only. |
| **C** | has a service | a real backend with an OpenAPI doc, partial overlap | the family questionnaire; this is the case the flow describes. |
| **D** | built to the contract | a conformant backend | `cupel-ready` passes, point and go. Rare, and it is what B and C become. |

**B is the wedge and the flow as described does not serve them** — they have no Swagger to
point at. That is the gap worth designing for, not C. The answer for B is that the command
accepts *an endpoint*, not a document: "where does your agent answer?" plus how it streams
(SSE / plain JSON / AG-UI). Everything else is mocked. That is a shim, not a contract match.

## The adoption ladder — what "guided instructions" should say

The generated app's README should not be a list of 66 operations. It should be four stages,
each independently useful, with the app fully working at every stage:

1. **Chat only — one endpoint.** Implement the chat endpoint with token streaming. Everything
   else stays mocked. Payoff: *their* agent answering in a real UI. Target: under an hour.
2. **Persistence — conversations and turns.** History survives a restart and is theirs.
3. **The studio — agents, instructions, versions.** Now instruction changes are versioned and
   the editor is live against their data.
4. **Evaluations and traces.** Replay, compare, judge, cost. The reason to stay.

Each stage is a family answer flipping from `mock` to `mine`. `cupel-ready` already reports
the gap; it should also **name which stage the adopter is on** and what the next endpoint is.

## Open decisions

| | question | recommendation |
|---|---|---|
| **1** | Is `<name>-ui/` a **copy** of the source (fork, editable, never updates) or a thin shell depending on a published package (updates flow, less editable)? | Copy — the package is unpublished and `private: true`, so it is the only thing that works today. But say so explicitly in the generated README, because "you will not get our updates" is a real cost the adopter must consent to. |
| ~~2~~ | Node mock: port and delete Python? | **REVERSED 2026-08-09: never porting.** Python stays; the generated folder either requires Python or ships no mock — see above. |
| 3 | Does the command accept a bare endpoint (persona B) as well as an OpenAPI document? | Yes — B is the wedge. Without it this flow only serves C. |
| 4 | Is `hide` per family only, or also per feature within a family? | Per family for v1. Per feature is a settings surface, not a generator flag. |
| 5 | Name: `<name>-ui` says UI, but the folder contains the mock too. | `<name>-studio` or just `<name>`. Minor, decide before the first README says it. |

## What this changes in the queue

- **#21** absorbs #25 and this plan; its five old open questions (Q5–Q8 on scaffolding a
  backend) are mostly unaffected, but Q4 is now answered: yes, redundant, delete #25.
- **#25** becomes "keep the served-by-mock badge", a small piece of #21.
- **New task needed:** port the mock to Node (see decision 2), sequenced before #21.
- **#12** (studio-only hypothesis) can be tested by this flow's `hide` answer rather than by
  a separate exercise.
