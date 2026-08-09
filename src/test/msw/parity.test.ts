// The drift guard for the fake backend.
//
// Why this file exists: handlers.ts grew task by task, each task adding only
// what it needed. Nothing forced the fake to agree with openapi.yaml, so a UI
// test could pass against a shape the real server would reject. This test
// closes that by machine-checking three things:
//
//   1. COVERAGE — every method on the single API client (src/api/client.ts) is
//      exercised here, reaches a path the CONTRACT defines, and is answered by
//      an MSW handler. Adding an api.* method without adding an exercise fails
//      (the table is checked against Object.keys(api) at runtime).
//   2. DRIFT — every MSW route registered on a backend base maps to a contract
//      operation. Invented routes fail unless allowlisted with a reason.
//   3. SHAPE — every JSON response the handlers produce is validated against
//      the contract schema declared for that operation + status code: required
//      keys, types, enums, and NO invented properties. SSE frames are validated
//      too, via the contract's own x-sse-events map.
//
// Depth of the shape check (deliberate, mirrors scripts/conformance.mjs's
// "shallow but honest" stance): structural JSON-Schema validation — required /
// type / enum / nullable / oneOf|anyOf|allOf / unknown-property detection,
// recursing through properties and array items. NOT checked: string formats,
// numeric bounds, pattern, minItems — none of which a fake fixture can get
// wrong in a way that would fool a UI test.
//
// Contract operations the UI cannot reach are NOT faked (parity means "the
// fake agrees with the contract where we use it", not "reimplement the server
// in TypeScript"). Each such operation is listed in UNEXERCISED_OPS with a
// reason, so the exclusion is reviewable rather than silent.
import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import YAML from "yaml";
import SwaggerParser from "@apidevtools/swagger-parser";
import { api } from "../../api/client";
import { server } from "./server";
import {
  BASE,
  LOCAL_BASE,
  adminConversationConfig,
  handlers,
  importConfig,
  mockLastSelections,
  mockEvaluationSummaries,
  mockTrees,
  pushHumanJudgment,
  pushLlmJudgment,
  taskStreamRig,
  uploadConfig,
} from "./handlers";

// ---------------------------------------------------------------- contract
// Same two libraries the existing contract tooling uses (yaml +
// @apidevtools/swagger-parser, tests/openapi-contract.test.js and
// scripts/conformance.mjs) — no new dependency. The doc is parsed HERE and
// dereferenced IN MEMORY rather than by path: this suite runs in the "ui"
// (jsdom) vitest project, where swagger-parser resolves a relative filename
// against jsdom's location and issues an HTTP GET that MSW then rejects.
interface OpenApiDoc {
  paths: Record<string, Record<string, Operation>>;
  components: {
    schemas: Record<string, Schema>;
    responses: Record<string, { content?: Record<string, { schema?: Schema }> }>;
  };
}
interface Operation {
  responses: Record<string, ResponseObject>;
}
interface ResponseObject {
  content?: Record<string, { schema?: Schema; "x-sse-events"?: Record<string, string> }>;
}
interface Schema {
  type?: string;
  nullable?: boolean;
  enum?: unknown[];
  required?: string[];
  properties?: Record<string, Schema>;
  items?: Schema;
  additionalProperties?: boolean | Schema;
  oneOf?: Schema[];
  anyOf?: Schema[];
  allOf?: Schema[];
}

// Top-level await, as in src/test/setup.ts. Circular schemas (Task.children →
// Task) come back as real circular JS references; the validator recurses over
// the VALUE, which is always finite, so that is safe.
const doc = (await SwaggerParser.dereference(
  YAML.parse(readFileSync("openapi.yaml", "utf8")),
)) as unknown as OpenApiDoc;

const HTTP_METHODS = ["get", "put", "post", "delete", "patch"] as const;

/** "GET /agenttrees/{tree}/evaluations" for every operation the contract defines. */
const CONTRACT_OPS = new Set<string>();
for (const [path, item] of Object.entries(doc.paths)) {
  for (const method of HTTP_METHODS) {
    if (item[method]) CONTRACT_OPS.add(`${method.toUpperCase()} ${path}`);
  }
}

/**
 * Concrete "/agenttrees/agent1/evaluations" → templated contract path, or null.
 * Literal paths win over templated ones so /tasks/stream never resolves to
 * /tasks/{taskId} (and /eval/cases/import never to /eval/cases/{caseId}).
 */
function matchContractPath(pathname: string): string | null {
  if (doc.paths[pathname]) return pathname;
  const parts = pathname.split("/");
  for (const template of Object.keys(doc.paths)) {
    const tParts = template.split("/");
    if (tParts.length !== parts.length) continue;
    if (tParts.every((t, i) => (t.startsWith("{") && t.endsWith("}")) || t === parts[i])) {
      return template;
    }
  }
  return null;
}

/** MSW's ":param" route templates use the same shape check. */
function matchRouteToContract(route: string): string | null {
  return matchContractPath(route.replace(/:[^/]+/g, "{x}"));
}

/** Frames the chat SSE exercise saw, through the real client parser. */
const chatFrames: Array<[string, unknown]> = [];

// ------------------------------------------------------------- validation
type Problem = string;

function typeOf(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

function typeMatches(expected: string, value: unknown): boolean {
  switch (expected) {
    case "integer":
      return typeof value === "number" && Number.isInteger(value);
    case "number":
      return typeof value === "number";
    case "string":
      return typeof value === "string";
    case "boolean":
      return typeof value === "boolean";
    case "array":
      return Array.isArray(value);
    case "object":
      return typeof value === "object" && value !== null && !Array.isArray(value);
    default:
      return true;
  }
}

/**
 * allOf composition (AdminConversationItem = Conversation + inspector fields)
 * has to be MERGED, not checked branch by branch: each branch alone would
 * report the other branch's keys as invented.
 */
function flattenAllOf(schema: Schema | undefined): Schema | undefined {
  if (!schema?.allOf) return schema;
  const merged: Schema = { type: "object", required: [], properties: {} };
  for (const raw of [...schema.allOf, { ...schema, allOf: undefined }]) {
    const branch = flattenAllOf(raw);
    if (!branch) continue;
    merged.type = branch.type ?? merged.type;
    // The single-branch allOf + nullable idiom ("nullable $ref") means the
    // WRAPPER carries the nullability — losing it would reject every legal null.
    merged.nullable = merged.nullable || branch.nullable;
    merged.enum = branch.enum ?? merged.enum;
    merged.items = branch.items ?? merged.items;
    merged.required = [...(merged.required ?? []), ...(branch.required ?? [])];
    Object.assign(merged.properties!, branch.properties ?? {});
    if (branch.additionalProperties !== undefined) {
      merged.additionalProperties = branch.additionalProperties;
    }
  }
  return merged;
}

/**
 * Structural validation of a response body against a contract schema.
 * Returns a list of human-readable problems; empty = conformant.
 */
function validate(value: unknown, rawSchema: Schema | undefined, at = "$"): Problem[] {
  const schema = flattenAllOf(rawSchema);
  if (!schema) return [];
  const problems: Problem[] = [];

  if (value === null) {
    // OpenAPI 3.0 nullability. oneOf wrappers carry no `type`, so a typeless
    // schema accepts null too.
    return schema.nullable || !schema.type ? [] : [`${at}: null but type is ${schema.type}`];
  }

  const union = schema.oneOf ?? schema.anyOf;
  if (union) {
    const branchProblems = union.map((branch) => validate(value, branch, at));
    if (branchProblems.every((p) => p.length)) {
      problems.push(
        `${at}: matches no ${schema.oneOf ? "oneOf" : "anyOf"} branch — ` +
          branchProblems.map((p, i) => `[${i}] ${p.join("; ")}`).join(" | "),
      );
    }
    return problems;
  }

  if (schema.type && !typeMatches(schema.type, value)) {
    problems.push(`${at}: expected ${schema.type}, got ${typeOf(value)}`);
    return problems;
  }

  if (schema.enum && !schema.enum.includes(value as never)) {
    problems.push(`${at}: ${JSON.stringify(value)} not in enum [${schema.enum.join(", ")}]`);
  }

  if (Array.isArray(value) && schema.items) {
    value.forEach((entry, i) => problems.push(...validate(entry, schema.items, `${at}[${i}]`)));
    return problems;
  }

  if (typeof value === "object" && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    for (const key of schema.required ?? []) {
      if (!(key in record)) problems.push(`${at}: missing required key '${key}'`);
    }
    const props = schema.properties ?? {};
    for (const [key, entry] of Object.entries(record)) {
      if (props[key]) {
        problems.push(...validate(entry, props[key], `${at}.${key}`));
      } else if (Object.keys(props).length && !schema.additionalProperties) {
        // Invention guard: a fixture key the contract never declares.
        problems.push(`${at}: property '${key}' is not in the contract schema`);
      } else if (typeof schema.additionalProperties === "object") {
        problems.push(...validate(entry, schema.additionalProperties, `${at}.${key}`));
      }
    }
  }

  return problems;
}

/** The JSON schema the contract declares for op + status, if any. */
function jsonSchemaFor(op: string, status: number): Schema | undefined {
  const [method, path] = op.split(" ");
  const operation = doc.paths[path]?.[method.toLowerCase()];
  const response = operation?.responses?.[String(status)];
  return response?.content?.["application/json"]?.schema;
}

/** event name → schema, from the contract's own x-sse-events map. */
function sseSchemasFor(op: string, status: number): Record<string, Schema> {
  const [method, path] = op.split(" ");
  const operation = doc.paths[path]?.[method.toLowerCase()];
  const response = operation?.responses?.[String(status)];
  const map = response?.content?.["text/event-stream"]?.["x-sse-events"] ?? {};
  return Object.fromEntries(
    // x-sse-events values are plain "#/components/schemas/X" STRINGS, not
    // $ref objects, so dereference leaves them alone — look them up by name.
    Object.entries(map).map(([event, ref]) => [event, doc.components.schemas[ref.split("/").pop()!]]),
  );
}

function declaredStatuses(op: string): string[] {
  const [method, path] = op.split(" ");
  return Object.keys(doc.paths[path]?.[method.toLowerCase()]?.responses ?? {});
}

// ------------------------------------------------------------- the recorder
interface Exchange {
  apiMethod: string;
  method: string;
  pathname: string;
  status: number;
  contentType: string;
  body: unknown;
  /** SSE frames the handler itself produced, as [event, data] pairs. */
  frames: Array<[string, unknown]>;
}

const exchanges: Exchange[] = [];
let currentApiMethod = "";
const pending: Array<Promise<void>> = [];

// ------------------------------------------------------------- the exercises
// One entry per api.* method (chat has two, one per response mode). Args are
// fixture-valid so the handlers take their HAPPY path — an error body would
// be validated against the wrong schema and prove nothing about the fixture.
interface Exercise {
  apiMethod: keyof typeof api;
  /** Chat is exercised twice; the label disambiguates. */
  label?: string;
  run: () => Promise<unknown>;
}

const file = (name: string, body: string, type: string) =>
  new File([body], name, { type });

const EXERCISES: Exercise[] = [
  // --- reads first: nothing below has mutated the fixtures yet.
  { apiMethod: "me", run: () => api.me() },
  { apiMethod: "healthz", run: () => api.healthz() },
  { apiMethod: "models", run: () => api.models() },
  { apiMethod: "agentTrees", run: () => api.agentTrees() },
  { apiMethod: "endpoints", run: () => api.endpoints("agent1") },
  { apiMethod: "agents", run: () => api.agents("agent1") },
  { apiMethod: "instructions", run: () => api.instructions("agent1", "ag_concierge") },
  { apiMethod: "lastSelection", run: () => api.lastSelection("agent1", "ag_concierge") },
  { apiMethod: "conversations", run: () => api.conversations("agent1", { page: 1 }) },
  { apiMethod: "conversation", run: () => api.conversation("agent1", "c1") },
  { apiMethod: "evaluations", run: () => api.evaluations("agent1") },
  { apiMethod: "evaluation", run: () => api.evaluation("agent1", "evaluation-old-1") },
  { apiMethod: "trace", run: () => api.trace("agent1", "t2") },
  { apiMethod: "spanPayload", run: () => api.spanPayload("sp-llm") },
  { apiMethod: "tasks", run: () => api.tasks({ limit: 10 }) },
  { apiMethod: "task", run: () => api.task("task-seed-replay") },
  { apiMethod: "rubrics", run: () => api.rubrics() },
  { apiMethod: "evalCase", run: () => api.evalCase("case-1") },
  { apiMethod: "evalSets", run: () => api.evalSets() },
  { apiMethod: "judgments", run: () => api.judgments({ page: 1 }) },
  { apiMethod: "evaluationSummary", run: () => api.evaluationSummary("evaluation-old-1") },
  { apiMethod: "evalSet", run: () => api.evalSet("set-misses") },

  // Second reads over the fixtures whose SHAPE differs from the first: forks
  // carry lineage, the re-fire evaluation carries per-endpoint cells, the finished
  // fork task carries result, a running trace carries an open span, a tool
  // span carries args/result instead of prompt/response.
  {
    apiMethod: "conversations",
    label: "conversations (forks_of)",
    run: () => api.conversations("agent1", { forks_of: "c2" }),
  },
  {
    apiMethod: "conversation",
    label: "conversation (fork, lineage)",
    run: () => api.conversation("agent1", "c2f1"),
  },
  { apiMethod: "evaluation", label: "evaluation (turn re-fire pivot)", run: () => api.evaluation("agent1", "evaluation-refire-1") },
  { apiMethod: "task", label: "task (finished fork, result)", run: () => api.task("task-seed-fork") },
  {
    apiMethod: "tasks",
    label: "tasks (children of a parent)",
    run: () => api.tasks({ parent_id: "task-seed-replay" }),
  },
  { apiMethod: "trace", label: "trace (running span)", run: () => api.trace("agent1", "t-live") },
  {
    apiMethod: "spanPayload",
    label: "spanPayload (tool args/result)",
    run: () => api.spanPayload("sp-tool"),
  },
  { apiMethod: "adminUsers", run: () => api.adminUsers() },
  { apiMethod: "userPermissions", run: () => api.userPermissions("u_admin") },
  { apiMethod: "adminConversations", run: () => api.adminConversations({ page: 1 }) },

  // --- auth
  { apiMethod: "login", run: () => api.login("admin@demo", "demo") },
  { apiMethod: "logout", run: () => api.logout() },

  // --- streaming
  {
    apiMethod: "chat",
    label: "chat (SSE)",
    run: async () => {
      const sent = await api.chat("agent1", { message: "hello", stream: true });
      if (sent.kind !== "stream") throw new Error("expected an SSE response");
      // Consumed through the real client parser, so these frames ARE what a
      // page would see; validated below against the contract's x-sse-events.
      for await (const frame of sent.events) chatFrames.push([frame.event, frame.data]);
    },
  },
  {
    apiMethod: "chat",
    label: "chat (JSON)",
    run: () => api.chat("agent1", { message: "hello", stream: false }),
  },
  {
    apiMethod: "taskStream",
    run: async () => {
      const controller = new AbortController();
      const stream = api.taskStream({ signal: controller.signal });
      const first = stream.next();
      await new Promise((r) => setTimeout(r, 20));
      // Close the SSE body server-side rather than aborting: an abort does not
      // propagate into MSW's ReadableStream, so the generator would never
      // settle. The response headers (all this exercise checks) are already out.
      taskStreamRig.closeAll();
      await first.catch(() => undefined);
      controller.abort();
    },
  },

  // --- multipart
  { apiMethod: "upload", run: () => api.upload(file("spec.pdf", "pdf-bytes", "application/pdf")) },
  {
    apiMethod: "importEvalCases",
    run: () =>
      api.importEvalCases(file("cases.csv", "q,a\n1,2\n", "text/csv"), {
        input: "q",
        output: "a",
      }),
  },

  // --- writes
  { apiMethod: "postFeedback", run: () => api.postFeedback({ message_id: "t2", rating: "up" }) },
  {
    apiMethod: "createAgent",
    run: () => api.createAgent("agent1", { name: "Parity", parent_id: "ag_concierge" }),
  },
  {
    apiMethod: "saveInstructions",
    run: () => api.saveInstructions("agent1", "ag_concierge", { content: "Parity v4." }),
  },
  {
    apiMethod: "createSnapshot",
    run: () => api.createSnapshot("agent1", "ag_concierge", { content: "Parity draft." }),
  },
  {
    apiMethod: "putLastSelection",
    run: () => api.putLastSelection("agent1", "ag_concierge", { items: [{ conversation_id: "c1" }] }),
  },
  {
    apiMethod: "renameConversation",
    run: () => api.renameConversation("agent1", "c1", "Renamed by parity"),
  },
  {
    apiMethod: "replay",
    run: () =>
      api.replay("agent1", {
        selection: [{ conversation_id: "c1" }],
        configs: [{ instruction_version: 3 }],
      }),
  },
  {
    apiMethod: "replayTurn",
    run: () =>
      api.replayTurn("agent1", {
        conversation_id: "c2",
        turn_id: "t9",
        endpoints: ["ep_agent1_prod"],
      }),
  },
  {
    apiMethod: "judge",
    run: () => api.judge({ evaluation_id: "evaluation-old-1", judge_model: "claude-haiku-4-5", rubric_id: "rub-help" }),
  },
  { apiMethod: "createRubric", run: () => api.createRubric({ name: "parity", prompt: "Score it." }) },
  { apiMethod: "updateRubric", run: () => api.updateRubric("rub-help", { prompt: "Score it better." }) },
  {
    apiMethod: "createEvalCase",
    run: () => api.createEvalCase({ input: { prompt: "Hi" }, output: "Hello" }),
  },
  {
    apiMethod: "createEvalCase",
    label: "createEvalCase (sourced from a turn)",
    run: () =>
      api.createEvalCase({ source: { tree: "agent1", conversation_id: "c1", turn_id: "t2" } }),
  },
  {
    apiMethod: "updateEvalCase",
    run: () => api.updateEvalCase("case-1", { input: { prompt: "Hi" }, output: "Hello again" }),
  },
  { apiMethod: "createEvalSet", run: () => api.createEvalSet({ name: "parity-set" }) },
  { apiMethod: "updateEvalSet", run: () => api.updateEvalSet("set-refunds", { items: [{ case_id: "case-1" }] }) },
  {
    apiMethod: "updateEvalSetMetadata",
    run: () => api.updateEvalSetMetadata("set-misses", { name: "Renamed" }),
  },
  {
    apiMethod: "addEvalSetItem",
    run: () =>
      api.addEvalSetItem("set-misses", {
        source: { tree: "agent1", conversation_id: "c2", turn_id: "t9" },
      }),
  },
  // Replay BEFORE freeze: replay re-fires reference items, so it needs one to
  // still be a reference — freezing is what takes them out of its reach.
  {
    apiMethod: "replayEvalSet",
    run: () => api.replayEvalSet("set-misses", { configs: [{ instruction_version: 3 }] }),
  },
  {
    apiMethod: "freezeEvalSetItems",
    run: () => api.freezeEvalSetItems("set-misses"),
  },
  { apiMethod: "putAdminUsers", run: () => api.putAdminUsers([{ email: "parity@demo" }]) },
  {
    apiMethod: "putUserPermissions",
    run: () => api.putUserPermissions("u_admin", { agent1: ["view"] }),
  },
  { apiMethod: "toggleTree", run: () => api.toggleTree("agent2", false) },
  { apiMethod: "retryFailedTask", run: () => api.retryFailedTask("task-seed-replay") },
  { apiMethod: "cancelTask", run: () => api.cancelTask("task-seed-replay") },

  // --- deletes last: they remove the fixtures the reads above needed.
  { apiMethod: "deleteEvalSet", run: () => api.deleteEvalSet("set-misses") },
  { apiMethod: "deleteConversation", run: () => api.deleteConversation("agent1", "c3") },
];

// The one write MSW models with an explicit knob rather than a size threshold.
const IMPORT_QUEUED_EXERCISE: Exercise = {
  apiMethod: "importEvalCases",
  label: "importEvalCases (202 queued)",
  run: () => {
    importConfig.queued = true;
    return api.importEvalCases(file("big.csv", "q,a\n", "text/csv"), {
      input: "q",
      output: "a",
    });
  },
};

// ------------------------------------------------------- error exercises
// Happy paths alone would leave the 4xx bodies unchecked — and those ARE what
// the client's ApiError{status,code,message} is built from. Each entry names
// the status and code the real backend would answer (mock/main.py's err()).
interface ErrorExercise {
  label: string;
  status: number;
  code: string;
  run: () => Promise<unknown>;
}

const ERROR_EXERCISES: ErrorExercise[] = [
  { label: "conversation 404", status: 404, code: "not_found", run: () => api.conversation("agent1", "nope") },
  { label: "agents on an unknown tree 404", status: 404, code: "not_found", run: () => api.agents("nope") },
  {
    label: "instructions for an unknown agent 404",
    status: 404,
    code: "not_found",
    run: () => api.instructions("agent1", "nope"),
  },
  { label: "evaluation 404", status: 404, code: "not_found", run: () => api.evaluation("agent1", "nope") },
  { label: "trace 404", status: 404, code: "not_found", run: () => api.trace("agent1", "nope") },
  { label: "spanPayload 404", status: 404, code: "not_found", run: () => api.spanPayload("nope") },
  { label: "task 404", status: 404, code: "not_found", run: () => api.task("nope") },
  { label: "retryFailedTask 404", status: 404, code: "not_found", run: () => api.retryFailedTask("nope") },
  { label: "evalCase 404", status: 404, code: "not_found", run: () => api.evalCase("nope") },
  {
    label: "updateEvalCase 404",
    status: 404,
    code: "not_found",
    run: () => api.updateEvalCase("nope", { input: { prompt: "p" }, output: "o" }),
  },
  {
    label: "updateEvalSet 404",
    status: 404,
    code: "not_found",
    run: () => api.updateEvalSet("nope", { items: [] }),
  },
  {
    label: "updateRubric 404",
    status: 404,
    code: "not_found",
    run: () => api.updateRubric("nope", { prompt: "p" }),
  },
  { label: "evaluationSummary 404", status: 404, code: "not_found", run: () => api.evaluationSummary("nope") },
  { label: "evalSet 404", status: 404, code: "not_found", run: () => api.evalSet("nope") },
  {
    label: "updateEvalSetMetadata 404",
    status: 404,
    code: "not_found",
    run: () => api.updateEvalSetMetadata("nope", { name: "x" }),
  },
  { label: "deleteEvalSet 404", status: 404, code: "not_found", run: () => api.deleteEvalSet("nope") },
  {
    label: "addEvalSetItem 404",
    status: 404,
    code: "not_found",
    run: () =>
      api.addEvalSetItem("nope", {
        source: { tree: "agent1", conversation_id: "c1", turn_id: "t2" },
      }),
  },
  {
    label: "freezeEvalSetItems 404",
    status: 404,
    code: "not_found",
    run: () => api.freezeEvalSetItems("nope"),
  },
  {
    label: "replayEvalSet 404",
    status: 404,
    code: "not_found",
    run: () => api.replayEvalSet("nope", { configs: [{}] }),
  },
  {
    label: "userPermissions 404",
    status: 404,
    code: "not_found",
    run: () => api.userPermissions("nope"),
  },
  {
    label: "putUserPermissions 404",
    status: 404,
    code: "not_found",
    run: () => api.putUserPermissions("nope", {}),
  },
  { label: "toggleTree 404", status: 404, code: "not_found", run: () => api.toggleTree("nope", false) },
  {
    label: "login with bad credentials 401",
    status: 401,
    code: "invalid_credentials",
    run: () => api.login("admin@demo", "wrong"),
  },
  {
    label: "adminConversations without the inspect role 403",
    status: 403,
    code: "forbidden",
    run: () => {
      adminConversationConfig.forbidden = true;
      return api.adminConversations().finally(() => {
        adminConversationConfig.forbidden = false;
      });
    },
  },
  {
    label: "upload over the size limit 413",
    status: 413,
    code: "too_large",
    run: () => {
      uploadConfig.maxBytes = 4;
      return api
        .upload(file("huge.bin", "not four bytes", "application/octet-stream"))
        .finally(() => {
          uploadConfig.maxBytes = 5 * 1024 * 1024;
        });
    },
  },
  {
    label: "judge with no selector 422",
    status: 422,
    code: "invalid",
    run: () => api.judge({ judge_model: "claude-haiku-4-5", rubric_id: "rub-help" }),
  },
];

/**
 * 422 is the one status MSW answers that openapi.yaml v0.3.0 declares on a
 * single operation (POST /eval/cases/import). mock/main.py returns it just as
 * freely — err(422, "invalid", …) guards every malformed body — so MSW agrees
 * with the reference implementation, and it is the CONTRACT that is behind.
 * Already tracked: TASKS.md P3-T00 v0.4.0, "Error.details[]/request_id + 422/
 * 429/503". Listed here so the exception is explicit rather than tolerated.
 */
const UNDECLARED_ERROR_STATUSES = new Set([422]);

// --------------------------------------------------------------- allowlists
/**
 * Contract operations no UI code path can reach, so MSW deliberately does not
 * fake them. Each needs a reason: this is the reviewable record of what the
 * fake does NOT cover. Adding a client method for any of these makes the
 * coverage test fail until the entry is removed and an exercise added.
 */
const UNEXERCISED_OPS: Record<string, string> = {
  "POST /agenttrees":
    "Generator seed path only (openapi.yaml:455-473 'exists for API completeness and seeding'). No UI creates trees — there is not even a tree switcher yet (TASKS.md UX-phase note).",
  "GET /agenttrees/{tree}/memory":
    "P3-MEM (TASKS.md). Contract shipped in v0.3.0; the memory panel is Phase 3, so no client method exists.",
  "PUT /agenttrees/{tree}/memory": "P3-MEM — see GET /agenttrees/{tree}/memory.",
  "DELETE /agenttrees/{tree}/memory": "P3-MEM — see GET /agenttrees/{tree}/memory.",
  "POST /agenttrees/{tree}/memory/compact": "P3-MEM — see GET /agenttrees/{tree}/memory.",
  "POST /admin/generator":
    "P3-GEN (TASKS.md) — the Settings drip-rate controls are greyed placeholders until then.",
  "GET /admin/generator/status": "P3-GEN — see POST /admin/generator.",
  "GET /settings":
    "No client method: the backend target is device-local in agentic.config.ts (feature-spec.md:157) and chat settings are ChatPage state (docs/review-2026-08-05.md A5). A Settings-page binding is a UX-phase decision.",
  "PUT /settings": "No client method — see GET /settings.",
};

/**
 * MSW routes that intentionally do not correspond to a contract operation.
 * Empty is the goal; an entry here is a deliberate, reviewed exception.
 */
const HANDLER_DRIFT_ALLOWLIST: Record<string, string> = {};

// ------------------------------------------------------------------- setup
// Every exercise runs once, here, and the responses are validated by the
// tests below — so a fixture change surfaces as ONE named failing test rather
// than as an unexplained hook error.
beforeAll(async () => {
  // Depth, not just presence: several stores start EMPTY, and validating `[]`
  // or `{scorers: []}` would prove nothing about the item shape. Seed the
  // thin ones so every collection the exercises read has at least one row.
  pushHumanJudgment("t2", "c1", "up", "2026-08-04T09:59:00Z", "clear answer");
  pushLlmJudgment({ case_id: "case-1", evaluation_id: "evaluation-old-1", score: 0.92 });
  mockEvaluationSummaries["evaluation-old-1"] = {
    evaluation_id: "evaluation-old-1",
    scorers: [
      {
        scorer: { kind: "llm", ref: "rub-help", version: 2, model: null },
        mean: 0.86,
        count: 4,
        distribution: [0, 1, 3],
      },
    ],
  };
  mockLastSelections.ag_concierge = [{ conversation_id: "c1", turn_ids: ["t2"] }];

  server.events.on("response:mocked", ({ request, response }) => {
    const contentType = response.headers.get("content-type") ?? "";
    const url = new URL(request.url);
    const exchange: Exchange = {
      apiMethod: currentApiMethod,
      method: request.method,
      pathname: url.pathname,
      status: response.status,
      contentType,
      body: undefined,
      frames: [],
    };
    exchanges.push(exchange);
    if (contentType.includes("application/json")) {
      pending.push(
        response
          .clone()
          .text()
          .then((text) => {
            exchange.body = text ? JSON.parse(text) : undefined;
          }),
      );
    }
  });

  for (const exercise of [...EXERCISES, IMPORT_QUEUED_EXERCISE]) {
    currentApiMethod = exercise.label ?? exercise.apiMethod;
    try {
      // A hung exercise must name itself rather than time the whole hook out.
      await Promise.race([
        exercise.run(),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error("exercise did not settle in 5s")), 5000),
        ),
      ]);
    } catch (error) {
      exchanges.push({
        apiMethod: currentApiMethod,
        method: "THREW",
        pathname: String(error),
        status: 0,
        contentType: "",
        body: undefined,
        frames: [],
      });
    }
  }
  for (const exercise of ERROR_EXERCISES) {
    currentApiMethod = exercise.label;
    try {
      await exercise.run();
      exchanges.push({
        apiMethod: exercise.label,
        method: "THREW",
        pathname: "resolved, but an error was expected",
        status: 0,
        contentType: "",
        body: undefined,
        frames: [],
      });
    } catch {
      // The 4xx is already in `exchanges` via the recorder.
    }
  }

  await Promise.all(pending);
}, 120_000);

const exchangesFor = (label: string) => exchanges.filter((e) => e.apiMethod === label);
const labelOf = (e: Exercise) => e.label ?? e.apiMethod;
const ALL_EXERCISES = [...EXERCISES, IMPORT_QUEUED_EXERCISE];

// -------------------------------------------------------------------- tests
describe("MSW ↔ contract parity: coverage", () => {
  it("every api.* method is exercised here", () => {
    const covered = new Set(ALL_EXERCISES.map((e) => e.apiMethod));
    const missing = Object.keys(api).filter((name) => !covered.has(name as keyof typeof api));
    expect(missing, "add an entry to EXERCISES for each new client method").toEqual([]);
  });

  it("every exercised client call reaches a contract operation and an MSW handler", () => {
    const problems: string[] = [];
    for (const exercise of ALL_EXERCISES) {
      const seen = exchangesFor(labelOf(exercise));
      if (!seen.length) {
        problems.push(`${labelOf(exercise)}: no request reached MSW`);
        continue;
      }
      for (const exchange of seen) {
        if (exchange.method === "THREW") {
          problems.push(`${labelOf(exercise)}: client threw — ${exchange.pathname}`);
          continue;
        }
        const template = matchContractPath(exchange.pathname);
        const op = template && `${exchange.method} ${template}`;
        if (!op || !CONTRACT_OPS.has(op)) {
          problems.push(
            `${labelOf(exercise)}: ${exchange.method} ${exchange.pathname} is not a contract operation`,
          );
        }
      }
    }
    expect(problems).toEqual([]);
  });

  it("contract operations with no exercise are allowlisted with a reason", () => {
    const exercised = new Set<string>();
    for (const exchange of exchanges) {
      if (exchange.method === "THREW") continue;
      const template = matchContractPath(exchange.pathname);
      if (template) exercised.add(`${exchange.method} ${template}`);
    }
    const unexercised = [...CONTRACT_OPS].filter((op) => !exercised.has(op)).sort();
    expect(unexercised).toEqual(Object.keys(UNEXERCISED_OPS).sort());
    for (const [op, reason] of Object.entries(UNEXERCISED_OPS)) {
      expect(CONTRACT_OPS.has(op), `${op} is allowlisted but not in the contract`).toBe(true);
      expect(reason.length, `${op} needs a real reason`).toBeGreaterThan(30);
    }
  });
});

describe("MSW ↔ contract parity: drift", () => {
  it("every registered handler route maps to a contract operation", () => {
    const bases = [BASE, LOCAL_BASE];
    const drift: string[] = [];
    for (const handler of handlers) {
      const { method, path } = handler.info as { method: string; path: string };
      const base = bases.find((b) => path.startsWith(b));
      const route = base === undefined ? path : path.slice(base.length);
      const template = matchRouteToContract(route);
      const op = template && `${method.toUpperCase()} ${template}`;
      if (!op || !CONTRACT_OPS.has(op)) {
        const key = `${method.toUpperCase()} ${route}`;
        if (!HANDLER_DRIFT_ALLOWLIST[key]) drift.push(key);
      }
    }
    expect(drift, "handler invents a route the contract does not define").toEqual([]);
  });
});

describe("MSW ↔ contract parity: response shapes", () => {
  it.each(ALL_EXERCISES.map((e) => [labelOf(e)] as const))(
    "%s answers a declared status with a contract-shaped body",
    (label) => {
      const seen = exchangesFor(label);
      expect(seen.length, "the exercise made no request").toBeGreaterThan(0);
      const problems: string[] = [];
      for (const exchange of seen) {
        if (exchange.method === "THREW") {
          problems.push(`client threw — ${exchange.pathname}`);
          continue;
        }
        const template = matchContractPath(exchange.pathname)!;
        const op = `${exchange.method} ${template}`;
        const statuses = declaredStatuses(op);
        if (!statuses.includes(String(exchange.status))) {
          problems.push(`${op}: status ${exchange.status} not declared (contract: ${statuses.join(", ")})`);
          continue;
        }
        if (exchange.body === undefined) continue; // 204 / SSE — nothing to check
        const schema = jsonSchemaFor(op, exchange.status);
        if (!schema) {
          problems.push(`${op} ${exchange.status}: no application/json schema declared`);
          continue;
        }
        problems.push(...validate(exchange.body, schema, `${op} ${exchange.status}`));
      }
      expect(problems).toEqual([]);
    },
  );

  it.each(ERROR_EXERCISES.map((e) => [e.label] as const))(
    "%s answers a contract-shaped Error body",
    (label) => {
      const exercise = ERROR_EXERCISES.find((e) => e.label === label)!;
      const seen = exchangesFor(label);
      expect(seen.length, "the exercise made no request").toBeGreaterThan(0);
      const problems: string[] = [];
      for (const exchange of seen) {
        if (exchange.method === "THREW") {
          problems.push(exchange.pathname);
          continue;
        }
        const op = `${exchange.method} ${matchContractPath(exchange.pathname)}`;
        if (exchange.status !== exercise.status) {
          problems.push(`${op}: answered ${exchange.status}, expected ${exercise.status}`);
          continue;
        }
        const declared = declaredStatuses(op);
        if (!declared.includes(String(exchange.status)) && !UNDECLARED_ERROR_STATUSES.has(exchange.status)) {
          problems.push(`${op}: status ${exchange.status} not declared (contract: ${declared.join(", ")})`);
        }
        // Error is {code, message} everywhere — validated against the
        // contract's own schema when declared, else the shared Error schema.
        const schema = jsonSchemaFor(op, exchange.status) ?? doc.components.schemas.Error;
        problems.push(...validate(exchange.body, schema, `${op} ${exchange.status}`));
        const code = (exchange.body as { code?: string } | undefined)?.code;
        if (code !== exercise.code) {
          problems.push(`${op}: code '${code}', expected '${exercise.code}'`);
        }
      }
      expect(problems).toEqual([]);
    },
  );

  it("chat SSE frames match the contract's x-sse-events schemas", () => {
    const schemas = sseSchemasFor("POST /agenttrees/{tree}/chat", 200);
    expect(Object.keys(schemas).sort()).toEqual(["done", "error", "task", "token"]);
    const problems: string[] = [];
    for (const [event, data] of chatFrames) {
      const schema = schemas[event];
      if (!schema) {
        problems.push(`chat emitted an undeclared SSE event '${event}'`);
        continue;
      }
      problems.push(...validate(data, schema, `chat event:${event}`));
    }
    expect(chatFrames.length, "the SSE exercise captured no frames").toBeGreaterThan(2);
    expect(problems).toEqual([]);
  });
});

describe("MSW ↔ contract parity: behavioural agreement with mock/main.py", () => {
  it("re-rating the same turn APPENDS a judgment (append-only invariant)", async () => {
    const first = await api.postFeedback({ message_id: "t2", rating: "up" });
    const second = await api.postFeedback({ message_id: "t2", rating: "down" });
    expect(second.id).not.toBe(first.id);
    const history = await api.judgments({ subject_kind: "turn", subject_id: "t2" });
    expect(history.map((j) => j.score)).toEqual([0, 1]); // newest first
  });

  it("PUT instructions creates a NEW version and moves the live pointer", async () => {
    const before = await api.instructions("agent1", "ag_concierge");
    const saved = await api.saveInstructions("agent1", "ag_concierge", { content: "next" });
    expect(saved.version).toBe(before.live_version + 1);
    const after = await api.instructions("agent1", "ag_concierge");
    expect(after.versions).toHaveLength(before.versions.length + 1);
    expect(after.live_version).toBe(saved.version);
    // The old version is still readable — nothing overwrites (openapi.yaml:243).
    expect(after.versions[0]).toEqual(before.versions[0]);
  });

  it("PUT eval case / set / rubric append a version, latest wins on read", async () => {
    const caseBefore = await api.evalCase("case-1");
    const caseAfter = await api.updateEvalCase("case-1", {
      input: { prompt: "p" },
      output: "o",
    });
    expect(caseAfter.version).toBe((caseBefore.version ?? 1) + 1);
    expect((await api.evalCase("case-1")).output).toBe("o");

    const setAfter = await api.updateEvalSet("set-refunds", { items: [] });
    expect(setAfter.version).toBe(4); // fixture is v3
    expect((await api.evalSets()).find((s) => s.id === "set-refunds")?.version).toBe(4);

    const rubricAfter = await api.updateRubric("rub-help", { prompt: "p" });
    expect(rubricAfter.version).toBe(3); // fixture is v2
  });

  it("collections come back in the order the server would sort them", async () => {
    // Judgments (listJudgments) + tasks + evaluations: newest first.
    await api.postFeedback({ message_id: "t2", rating: "up" });
    await api.postFeedback({ message_id: "t9", rating: "down" });
    expect((await api.judgments({}))[0].subject).toEqual({ kind: "turn", id: "t9" });

    const evaluations = await api.evaluations("agent1");
    expect(evaluations.map((r) => r.created_at)).toEqual(
      [...evaluations.map((r) => r.created_at)].sort().reverse(),
    );
    const tasks = await api.tasks();
    expect(tasks.map((t) => t.created_at)).toEqual(
      [...tasks.map((t) => t.created_at)].sort().reverse(),
    );
    // Conversations: last_activity_at DESC (mock/main.py:754, :910).
    const page = await api.conversations("agent1");
    expect(page.items.map((c) => c.last_activity_at)).toEqual(
      [...page.items.map((c) => c.last_activity_at)].sort().reverse(),
    );
  });

  it("POST /feedback accepts a just-streamed turn id — a documented divergence", async () => {
    // The real mock 404s an unknown message_id. MSW accepts it (see the
    // comment on the /feedback handler): a streamed assistant turn exists only
    // in the SSE frames, never in the conversation fixtures, and thumbing it is
    // the most-exercised chat interaction. Pinned so the divergence stays
    // deliberate rather than becoming a surprise.
    const judgment = await api.postFeedback({ message_id: "t-never-seeded", rating: "up" });
    expect(judgment.subject).toEqual({ kind: "turn", id: "t-never-seeded" });
    // No conversation scope, so ?conversation_id= never returns it.
    expect(await api.judgments({ conversation_id: "c1" })).not.toContainEqual(judgment);
  });

  it("adding the same turn to a set twice appends one version, then nothing", async () => {
    // The merged noun's duplicate rule: "adding a referent the latest version
    // already holds appends nothing and returns that version unchanged"
    // (mock/main.py add_set_item), so the caller reads an unchanged version
    // number as "already there".
    const item = {
      source: { tree: "agent1", conversation_id: "c2", turn_id: "t9" },
    } as const;
    const before = await api.evalSet("set-misses");
    const first = await api.addEvalSetItem("set-misses", item);
    const second = await api.addEvalSetItem("set-misses", item);
    expect(first.version).toBe(before.version + 1);
    expect(second.version).toBe(first.version);
    expect(
      (await api.evalSet("set-misses")).items.filter((i) => i.source?.turn_id === "t9"),
    ).toHaveLength(1);
  });

  it("freezing flips reference items in place, keeping their id", async () => {
    // "The item keeps its id and its source, so its provenance survives the
    // freeze" — the merge's replacement for POST /casebooks/{id}/to-eval-set.
    const before = await api.evalSet("set-misses");
    const reference = before.items.find((i) => i.kind === "reference")!;
    const after = await api.freezeEvalSetItems("set-misses");
    expect(after.version).toBe(before.version + 1);
    const frozen = after.items.find((i) => i.id === reference.id)!;
    expect(frozen.kind).toBe("frozen");
    expect(frozen.case_id).toBeTruthy();
    expect(frozen.source).toEqual(reference.source);
  });

  it("an unpermitted tree answers 404, never 403 (openapi.yaml NotFound)", async () => {
    await expect(api.agents("agent-nope")).rejects.toMatchObject({ status: 404, code: "not_found" });
    await expect(api.conversations("agent-nope")).rejects.toMatchObject({ status: 404 });
  });

  // Found while building this guard: the reference
  // implementation emits 409 tree_disabled from SIX operations whose contract
  // entries declare only 2xx/404. mock/main.py is right (feature-spec.md:20
  // "history is read-only"); openapi.yaml under-declares. Nothing is changed
  // here — openapi.yaml is read-only for this task and the mock's behaviour is
  // the specified one — but the gap is pinned so a v0.4.0 fix retires the note
  // in handlers.ts rather than leaving it to rot.
  it("pins the contract's undeclared-409 gap (retire when v0.4.0 adds them)", () => {
    const undeclared = [
      "POST /agenttrees/{tree}/agents",
      "PUT /agenttrees/{tree}/agents/{agentId}/instructions",
      "POST /agenttrees/{tree}/agents/{agentId}/snapshots",
      "PUT /agenttrees/{tree}/agents/{agentId}/last-selection",
      "PATCH /agenttrees/{tree}/conversations/{conversationId}",
      "DELETE /agenttrees/{tree}/conversations/{conversationId}",
    ];
    expect(undeclared.filter((op) => declaredStatuses(op).includes("409"))).toEqual([]);
    // The five that DO declare it must keep declaring it.
    for (const op of [
      "POST /agenttrees/{tree}/chat",
      "POST /agenttrees/{tree}/replay",
      "POST /agenttrees/{tree}/replay/turn",
      "POST /eval/judge",
      "POST /eval/sets/{setId}/replay",
    ]) {
      expect(declaredStatuses(op), op).toContain("409");
    }
  });

  it("a disabled tree 409s the documented write set and keeps reads working", async () => {
    mockTrees.find((t) => t.id === "agent1")!.enabled = false;
    // mock/main.py need_enabled_tree: chat, replay, replay/turn, create agent,
    // PUT instructions, POST snapshots, PUT last-selection, conversation
    // rename/delete. Feedback is NOT in the set — a thumb annotates history.
    await expect(api.chat("agent1", { message: "x" })).rejects.toMatchObject({ code: "tree_disabled" });
    await expect(
      api.replay("agent1", { selection: [{ conversation_id: "c1" }], configs: [{}] }),
    ).rejects.toMatchObject({ code: "tree_disabled" });
    await expect(
      api.replayTurn("agent1", { conversation_id: "c2", turn_id: "t9", endpoints: ["ep_agent1_prod"] }),
    ).rejects.toMatchObject({ code: "tree_disabled" });
    await expect(api.createAgent("agent1", { name: "x" })).rejects.toMatchObject({ code: "tree_disabled" });
    await expect(
      api.saveInstructions("agent1", "ag_concierge", { content: "x" }),
    ).rejects.toMatchObject({ code: "tree_disabled" });
    await expect(
      api.createSnapshot("agent1", "ag_concierge", { content: "x" }),
    ).rejects.toMatchObject({ code: "tree_disabled" });
    await expect(
      api.putLastSelection("agent1", "ag_concierge", { items: [] }),
    ).rejects.toMatchObject({ code: "tree_disabled" });
    await expect(api.renameConversation("agent1", "c1", "x")).rejects.toMatchObject({
      code: "tree_disabled",
    });
    await expect(api.deleteConversation("agent1", "c1")).rejects.toMatchObject({
      code: "tree_disabled",
    });
    // Reads and feedback stay open — "existing conversations stay READABLE".
    await expect(api.conversation("agent1", "c1")).resolves.toBeTruthy();
    await expect(api.evaluations("agent1")).resolves.toBeTruthy();
    await expect(api.postFeedback({ message_id: "t2", rating: "up" })).resolves.toBeTruthy();
  });
});
