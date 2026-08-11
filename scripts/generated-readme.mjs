// The README that ships INSIDE a generated folder — the adopter's first and
// often only document, so it is written for someone who has never read this
// repo (docs/plans/plan-adopter-onboarding.md "The adoption ladder").
//
// Two things it must say plainly, because burying either would be dishonest:
//   1. this folder is a COPY they own and it will NOT receive upstream fixes
//      (item 8's decision — that is the cost they are consenting to);
//   2. running the bundled mock needs Python 3.11+ (item 10b).
//
// It is a separate module from scripts/create-app.mjs so the prose is
// testable and reviewable on its own.

const ANSWER_WORDS = {
  mine: "your backend",
  mock: "the bundled mock",
  hide: "not rendered",
};

/** The four stages, each independently useful, each one family flipping to `mine`. */
export const LADDER = [
  {
    title: "Chat only — one endpoint",
    families: ["chat"],
    body:
      "Implement the chat endpoint with token streaming. Everything else stays as it is.\n" +
      "Payoff: your agent answering in a real UI. This is the stage that should take an hour,\n" +
      "not a sprint.",
  },
  {
    title: "Persistence — conversations and turns",
    families: ["conversations"],
    body:
      "List, read, rename and delete conversations, and read a conversation's turns.\n" +
      "Payoff: history survives a restart and it is yours, not the mock's.",
  },
  {
    title: "The studio — agents, instructions, versions",
    families: ["agents", "trees"],
    body:
      "The agent tree, its nodes, and instruction versions/snapshots.\n" +
      "Payoff: instruction changes are versioned and the editor is live against your data.",
  },
  {
    title: "Evaluations and traces",
    families: ["replay", "trace", "tasks", "datasets", "judging"],
    body:
      "Replay, the comparison grid, the span tree behind a turn, the background queue,\n" +
      "and the eval workbench. Payoff: the reason to keep the thing.",
  },
];

const bullet = (rows) => rows.map((row) => `- ${row}`).join("\n");

/**
 * @param {object} options
 * @param {{name: string, label: string}} options.product
 * @param {Record<string,string>} options.answers family -> mine|mock|hide
 * @param {{id: string, label: string, baseUrl: string}|null} options.target the adopter's backend
 * @param {{url: string, stream: string}|null} options.agentEndpoint persona B's bare endpoint
 * @param {string} options.contractVersion openapi.yaml version this copy carries
 * @param {boolean} options.needsPython whether anything is served by the bundled mock
 */
export function renderReadme({
  product,
  answers,
  target = null,
  agentEndpoint = null,
  contractVersion,
  needsPython,
}) {
  const byAnswer = (answer) =>
    Object.keys(answers)
      .filter((family) => answers[family] === answer)
      .sort();
  const mine = byAnswer("mine");
  const mocked = byAnswer("mock");
  const hidden = byAnswer("hide");

  const wiring = Object.keys(answers)
    .sort()
    .map((family) => `| \`${family}\` | ${answers[family]} | ${ANSWER_WORDS[answers[family]]} |`)
    .join("\n");

  const next = LADDER.filter((stage) => stage.families.some((f) => answers[f] === "mock"));

  return `# ${product.label}

A chat + studio UI for your agent, generated from Cupel. **This folder is yours.**

## What "yours" means

It is a COPY, not a dependency. Every file here is editable and nothing reaches back
upstream — which also means **you will not receive upstream fixes or new features**.
If Cupel fixes a bug next month, this folder still has it. That is the trade for
being able to change anything without asking anyone.

## Prerequisites

- Node >= 22.18 and npm.${
    needsPython
      ? `
- **Python 3.11+** — ${mocked.length} ${mocked.length === 1 ? "family is" : "families are"} served by the bundled mock backend (\`mock/\`, FastAPI + SQLite),
  and it needs Python. If you would rather not have Python in this project, set those
  families to \`hide\` in \`agentic.config.ts\` and delete \`mock/\`.`
      : `
- No Python needed: nothing in this app is served by the bundled mock.`
  }

## Start it

\`\`\`
npm install
npm start
\`\`\`

\`npm start\` runs the UI on http://localhost:5173${
    needsPython ? " and the bundled mock backend next to it" : ""
  }.
It prints what it booted and where its data lives before it serves anything.

## What is wired to what

| family | answer | served by |
|---|---|---|
${wiring}

${
  target
    ? `Your backend is \`${target.id}\` → ${target.baseUrl || "(same origin)"}.`
    : agentEndpoint
      ? `Your agent answers at ${agentEndpoint.url} (${agentEndpoint.stream} streaming), mapped onto the
chat contract by \`src/api/bareAgent.ts\`.`
      : "No backend of your own is configured yet — everything is the bundled mock."
}
${
  mocked.length > 0
    ? `\nScreens the mock is answering wear a **"served by mock"** badge. That badge is the
whole point: nobody should have to guess which half of the app is real.`
    : ""
}${
    hidden.length > 0
      ? `\n\nHidden (${hidden.join(", ")}): no nav entry, no route, no requests. Change your mind by
editing \`families\` in \`agentic.config.ts\`.`
      : ""
  }

## Hooking up your own backend

One file decides everything: **\`agentic.config.ts\`**. It holds your product name, your
backends, and the per-family answers above. \`openapi.yaml\` in this folder is the contract
those families come from — the shapes your endpoints have to speak.

Check where you stand at any time:

\`\`\`
npm run ready http://localhost:8000/openapi.json
\`\`\`

It reports, per family, how much of the contract your backend already satisfies. Flip a
family from \`mock\` to \`mine\` when its line reads \`full\`.

### The ladder

Each stage is independently useful and the app works at every one of them.

${LADDER.map(
  (stage, i) =>
    `**${i + 1}. ${stage.title}** — \`${stage.families.join("`, `")}\`\n\n${stage.body}`,
).join("\n\n")}

${
  next.length > 0
    ? `You are at **stage ${LADDER.indexOf(next[0]) + 1}**: ${next[0].title.toLowerCase()}.`
    : `Every family points at your own backend already — there is no stage left to climb.`
}

## What is NOT in this copy

${bullet([
  "The Cupel test suites (unit, contract, e2e). They assert Cupel's own wiring — with your\n  family answers they would fail on day one and teach you nothing. Write your own.",
  "Deployment manifests and the hosted-demo configuration.",
  "Cupel's internal docs and planning files.",
])}

## Layout

${bullet([
  "`agentic.config.ts` — the one config artifact: product name, backends, family answers.",
  "`openapi.yaml` — the contract (v" + contractVersion + ") this UI is written against.",
  "`src/` — the app. `src/api/client.ts` is the only place that talks HTTP.",
  "`mock/` — the bundled demo backend" + (needsPython ? "" : " (unused by your answers)") + ".",
  "`scripts/` — `dev.mjs` (npm start), `cupel-ready.mjs` (npm run ready), `init.mjs` (rename).",
])}

${
  mine.length > 0
    ? `Families already pointed at your backend: ${mine.join(", ")}.`
    : "Nothing points at a backend of yours yet — start with stage 1."
}
`;
}
