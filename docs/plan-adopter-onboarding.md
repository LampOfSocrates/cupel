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
the contract is ~69 operations across ~10 families, and the worked `cupel-ready --init`
example only reaches 37/69 because its remap was contrived for a backend already built to
this shape. A real first run is closer to 0–5 matched operations, which means 60+ questions
if we ask per endpoint. Group by family (chat · conversations · agents · instructions ·
evaluations · trace · tasks · eval workbench · casebooks · settings) and ask at most ten.

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

**DECIDED 2026-08-09 (user): port to Node, delete the Python mock.** Tracked as #40. Two
consequences worth stating up front:

- **Sequence #40 before #14.** The port carries the OLD names so every step stays green, and
  #14 then renames a TypeScript mock rather than a Python one — its 151 wire occurrences
  become a type-checked rename instead of a string replacement across two languages. Porting
  first makes the contract bump both cheaper and safer. Do **not** try to adopt the new names
  during the port; that couples two large changes with no green state between them.
- **The tech check gets shorter, which is the point.** Python 3.11+ and a pip install leave
  the quickstart entirely. Keep it that way: pick a SQLite binding with **no native build
  step** (`node:sqlite` if the engine floor can be raised to a major where it is unflagged;
  `better-sqlite3` needs a toolchain and reintroduces exactly the friction being removed).

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

The generated app's README should not be a list of 69 operations. It should be four stages,
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
| ~~2~~ | Node mock: port and delete Python? | **DECIDED 2026-08-09: port and delete.** #40, sequenced before #14 and #21. |
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
