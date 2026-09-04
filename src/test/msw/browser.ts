// The BROWSER half of the MSW rig — the sibling of ./server.ts.
//
// server.ts boots the same handlers under msw/node for vitest; this boots them
// in a Service Worker so the real app, in a real browser, runs against the
// contract fake with no backend process at all (`npm run dev:msw`). Only
// src/main.tsx imports it, behind a dynamic import gated on VITE_MSW, so
// nothing here reaches a production bundle.
//
// WHAT IT ADDS OVER server.ts: volume. The handlers' own fixtures are sized
// for assertions — three conversations, two traces — which proves a screen
// renders but does not look like the product. ./mockdata.ts is a snapshot of
// the seeded demo backend (see scripts/dump-mockdata.mjs) and is layered on
// top of those fixtures HERE, never in the handlers, so tests keep the small
// deterministic world they assert on (c1, t9, req_msw1) and only the browser
// sees the big one.
//
// State is in-memory: a page reload replays this seeding and drops anything
// you created while clicking around. The SQLite-backed demo backend
// (`npm start`) is the one that remembers.
import { setupWorker } from "msw/browser";

import { handlers } from "./handlers";
import { mockTrees } from "./state";
import { mockAgents, mockInstructions } from "./routes/agents";
import { mockForks, mockRoots } from "./routes/conversations";
import { mockEvaluations } from "./routes/evaluations";
import { mockEvalBenchmarks, mockEvalCases, mockRubrics } from "./routes/evalWorkbench";
import { mockJudgments } from "./routes/judgments";
import { mockEndpoints, mockModels } from "./routes/system";
import { mockTasks } from "./routes/tasks";
import { mockSpanPayloads, mockTraces } from "./routes/traces";
import {
  demoAgents,
  demoConversations,
  demoEndpoints,
  demoEvalBenchmarks,
  demoEvalCases,
  demoEvaluations,
  demoForks,
  demoInstructions,
  demoJudgments,
  demoModels,
  demoRubrics,
  demoSpanPayloads,
  demoTasks,
  demoTraces,
  demoTrees,
} from "./mockdata";

/**
 * Layer the demo dataset onto the handler fixtures, in place.
 *
 * In place matters: every route module closed over its array or record at
 * import time, so a reassignment would be invisible to the handlers — the same
 * reason resetConversations() splices rather than rebinds
 * (src/test/msw/routes/conversations.ts).
 *
 * Trees, agents, instructions and endpoints REPLACE their fixtures (the demo
 * backend's own bootstrap is the better version of the same five agents —
 * "Customer Support" rather than "Agent 1"); collections are APPENDED to, so
 * the fixture rows the handlers cross-reference stay reachable.
 */
export function seedDemoData(): void {
  mockTrees.length = 0;
  mockTrees.push(...demoTrees);

  // Replace only what the dump actually holds. A wipe-then-assign left the app
  // with NO agents when the dump came back empty — an emptier world than the
  // fixtures it replaced, which is never the point of loading demo data.
  for (const [tree, agents] of Object.entries(demoAgents)) {
    if (agents.length) mockAgents[tree] = agents;
  }
  Object.assign(mockInstructions, demoInstructions);
  Object.assign(mockEndpoints, demoEndpoints);

  // Conversations are held as ONE list across trees and scoped by tree_id at
  // read time, so both trees' roots go into the same array.
  mockRoots.push(...Object.values(demoConversations).flat());
  Object.assign(mockForks, demoForks);

  Object.assign(mockTraces, demoTraces);
  Object.assign(mockSpanPayloads, demoSpanPayloads);

  mockEvaluations.push(...(demoEvaluations as unknown as typeof mockEvaluations));
  mockJudgments.push(...demoJudgments);
  mockTasks.push(...demoTasks);

  mockRubrics.push(...demoRubrics);
  Object.assign(mockEvalCases, demoEvalCases);
  mockEvalBenchmarks.push(...demoEvalBenchmarks);

  if (demoModels.length) {
    mockModels.length = 0;
    mockModels.push(...demoModels);
  }
}

export const worker = setupWorker(...handlers);

/** Seed, then start intercepting. Awaited by src/main.tsx before the first render. */
export async function startWorker(): Promise<void> {
  seedDemoData();
  await worker.start({
    // The app ships static assets and fonts the worker has no handler for;
    // only an unhandled API call is worth a line in the console.
    onUnhandledRequest: "bypass",
    serviceWorker: { url: `${import.meta.env.BASE_URL}mockServiceWorker.js` },
  });
}
