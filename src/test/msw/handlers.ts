// MSW handlers — the fake backend every ui-project test runs against.
//
// This file is the composition point and the public surface: it stitches the
// per-domain route modules in ./routes into the one `handlers` array MSW is
// booted with, and re-exports every fixture, knob and capture array so tests
// keep importing from "…/msw/handlers". State more than one domain touches —
// the tree gates, the id counters, the SSE rig — lives in ./state.
//
// The agreement with openapi.yaml v0.3.0 is MACHINE-CHECKED rather than
// by-hand: parity.test.ts (same folder) exercises every method on
// src/api/client.ts through these handlers and validates each response
// against the contract schema the operation declares. Read that file before
// adding a handler — a new api.* method with no exercise, an invented route,
// a missing required key, an undeclared status or an out-of-enum value all
// fail there. Contract operations the UI cannot reach are deliberately NOT
// faked; each is listed with a reason in that file's UNEXERCISED_OPS.
//
// Behavioural rules the handlers mirror from the reference implementation
// (mock/main.py), because a UI test can lean on any of them: append-only
// judgments/versions with latest-version-wins reads, newest-first collections,
// idempotent eval-set item add, 404-never-403 for absent or unpermitted trees,
// and the 409 tree_disabled write set. Deliberate divergences are marked
// "DELIBERATE DIVERGENCE" (or "Documented divergence") at the handler that
// makes them — ./routes/judgments.ts (POST /feedback) and ./routes/evaluations.ts
// (POST /replay/turn) both accept a just-streamed turn id the real mock 404s.
import { resetSharedState, taskStreamRig } from "./state";
import { adminHandlers, resetAdmin } from "./routes/admin";
import { agentHandlers, resetAgents } from "./routes/agents";
import { chatHandlers, resetChat } from "./routes/chat";
import { conversationHandlers, resetConversations } from "./routes/conversations";
import { evalHandlers, resetEvalWorkbench } from "./routes/evalWorkbench";
import { judgmentHandlers, resetJudgments } from "./routes/judgments";
import { evaluationHandlers, resetEvaluations } from "./routes/evaluations";
import { systemHandlers, resetSystem } from "./routes/system";
import { taskHandlers, resetTasks } from "./routes/tasks";
import { traceHandlers, resetTraces } from "./routes/traces";

export * from "./state";
export * from "./routes/admin";
export * from "./routes/agents";
export * from "./routes/chat";
export * from "./routes/conversations";
export * from "./routes/evalWorkbench";
export * from "./routes/judgments";
export * from "./routes/evaluations";
export * from "./routes/system";
export * from "./routes/tasks";
export * from "./routes/traces";

// MSW matches full paths, so cross-domain order is not load-bearing; the
// order WITHIN each module is (e.g. /eval/cases/import before
// /eval/cases/:caseId, /tasks and /tasks/stream before /tasks/:taskId).
export const handlers = [
  ...systemHandlers,
  ...adminHandlers,
  ...agentHandlers,
  ...conversationHandlers,
  ...chatHandlers,
  ...judgmentHandlers,
  ...evalHandlers,
  ...evaluationHandlers,
  ...traceHandlers,
  ...taskHandlers,
];

export function resetHandlerState() {
  resetSharedState();
  resetSystem();
  // Before resetAdmin: the Inspector rows are projections of the conversation
  // fixtures, so they must be rebuilt from freshly seeded roots.
  resetConversations();
  resetAdmin();
  resetAgents();
  resetChat();
  resetJudgments();
  resetEvalWorkbench();
  resetEvaluations();
  resetTraces();
  resetTasks();
  taskStreamRig.closeAll();
}
