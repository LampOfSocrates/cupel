import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import YAML from "yaml";
import SwaggerParser from "@apidevtools/swagger-parser";

const doc = YAML.parse(readFileSync("openapi.yaml", "utf8"));

// feature-spec.md:120-135 filtered to Phase 1 (skein-phases.md:9-66); tree-scoped
// per feature-spec.md:115, global routes unprefixed.
const PHASE1_PATHS = [
  "/me",
  "/healthz",
  "/models",
  "/agenttrees",
  "/agenttrees/{tree}/endpoints",
  "/agenttrees/{tree}/agents",
  "/agenttrees/{tree}/agents/{agentId}/instructions",
  "/agenttrees/{tree}/agents/{agentId}/snapshots",
  "/agenttrees/{tree}/agents/{agentId}/last-selection",
  "/agenttrees/{tree}/conversations",
  "/agenttrees/{tree}/conversations/{conversationId}",
  "/agenttrees/{tree}/chat",
  "/upload",
  "/feedback",
  "/agenttrees/{tree}/replay",
  "/agenttrees/{tree}/replay/turn",
  "/agenttrees/{tree}/runs",
  "/agenttrees/{tree}/runs/{runId}",
  "/agenttrees/{tree}/turns/{turnId}/trace",
  "/spans/{spanId}/payload",
  "/tasks",
  "/tasks/stream",
  "/tasks/{taskId}",
  "/tasks/{taskId}/retry-failed",
  "/eval/rubrics",
  "/eval/cases/{caseId}",
  "/eval/judge",
  "/eval/judgments",
  "/eval/runs/{runId}/summary",
];

describe("P1-T00 OpenAPI contract", () => {
  it("is valid OpenAPI 3.0 (refs resolve, schemas well-formed)", async () => {
    await SwaggerParser.validate("openapi.yaml");
  });

  it("defines exactly the Phase-1 endpoints", () => {
    expect(Object.keys(doc.paths).sort()).toEqual([...PHASE1_PATHS].sort());
  });

  it("tree-scoped resources live under /agenttrees/{tree} (feature-spec.md:115)", () => {
    for (const p of Object.keys(doc.paths)) {
      if (p.includes("{tree}")) {
        expect(p, `${p} must be scoped under /agenttrees/{tree}`).toMatch(
          /^\/agenttrees\/\{tree\}\//
        );
      }
    }
    for (const resource of ["chat", "conversations", "replay", "runs"]) {
      expect(doc.paths[`/agenttrees/{tree}/${resource}`]).toBeDefined();
    }
  });

  it("chat serves both modes on one endpoint via a stream flag (skein-phases.md:43)", () => {
    const stream = doc.components.schemas.ChatRequest.properties.stream;
    expect(stream.type).toBe("boolean");
    expect(stream.default).toBe(true);
    const content =
      doc.paths["/agenttrees/{tree}/chat"].post.responses["200"].content;
    expect(content["text/event-stream"]).toBeDefined();
    expect(content["application/json"]).toBeDefined();
  });

  it("turns carry the context envelope (feature-spec.md:76, :81)", () => {
    expect(doc.components.schemas.Turn.properties.envelope).toBeDefined();
    expect(doc.components.schemas.ContextEnvelope.required).toEqual([
      "system_date",
      "timezone",
      "region",
      "locale",
    ]);
  });

  it("append-only invariant: no update/delete on versions, snapshots, judgments", () => {
    expect(Object.keys(doc.paths["/eval/judgments"])).toEqual(["get"]);
    expect(
      Object.keys(doc.paths["/agenttrees/{tree}/agents/{agentId}/snapshots"])
    ).toEqual(["post"]);
    // PUT on instructions appends a new version, never overwrites (feature-spec.md:33)
    expect(
      Object.keys(
        doc.paths["/agenttrees/{tree}/agents/{agentId}/instructions"]
      ).sort()
    ).toEqual(["get", "put"]);
  });

  it("/me is defined — always called, both auth modes (feature-spec.md:120)", () => {
    expect(doc.paths["/me"].get).toBeDefined();
  });

  it("no auth anywhere — Phase 1 has no security schemes (skein-phases.md:10)", () => {
    expect(doc.security).toBeUndefined();
    expect(doc.components.securitySchemes).toBeUndefined();
    for (const [p, methods] of Object.entries(doc.paths)) {
      for (const [method, op] of Object.entries(methods)) {
        expect(op.security, `${method.toUpperCase()} ${p} must not declare security`).toBeUndefined();
      }
    }
  });

  it("SSE endpoints declare machine-checkable event schemas (x-sse-events)", () => {
    const sse = [
      doc.paths["/agenttrees/{tree}/chat"].post.responses["200"].content["text/event-stream"],
      doc.paths["/tasks/stream"].get.responses["200"].content["text/event-stream"],
    ];
    for (const stream of sse) {
      expect(stream["x-sse-events"]).toBeDefined();
      expect(stream.schema.oneOf.length).toBeGreaterThan(0);
      for (const ref of Object.values(stream["x-sse-events"])) {
        const name = ref.replace("#/components/schemas/", "");
        expect(doc.components.schemas[name], `${ref} must resolve`).toBeDefined();
      }
    }
    expect(Object.keys(sse[1]["x-sse-events"]).sort()).toEqual(["judgment", "progress", "span", "task"]);
  });

  it("no orphan schemas — every component is referenced", () => {
    const raw = readFileSync("openapi.yaml", "utf8");
    for (const name of Object.keys(doc.components.schemas)) {
      const refs = raw.split(`#/components/schemas/${name}`).length - 1;
      expect(refs, `schema ${name} must be $ref'd at least once`).toBeGreaterThan(0);
    }
  });

  it("task lifecycle and result deep-links (skein-phases.md:43, feature-spec.md:107)", () => {
    const task = doc.components.schemas.Task.properties;
    expect(task.status.enum).toEqual(["queued", "running", "done", "failed", "cancelled"]);
    expect(task.type.enum).toEqual(["chat", "replay", "replay_turn", "judge"]);
    expect(task.result.properties.run_id).toBeDefined();
  });

  it("envelope is required on turns and shown in the trace header (feature-spec.md:76)", () => {
    expect(doc.components.schemas.Turn.required).toContain("envelope");
    expect(doc.components.schemas.Trace.properties.envelope).toBeDefined();
  });

  it("machine-originated conversations are first-class (origin/author/idempotency)", () => {
    expect(doc.components.schemas.Conversation.required).toContain("origin");
    expect(doc.components.schemas.Conversation.properties.origin.enum).toEqual(["interactive", "machine"]);
    expect(doc.components.schemas.Turn.required).toContain("author");
    expect(doc.components.schemas.ChatRequest.properties.client_message_id).toBeDefined();
    const params = doc.paths["/agenttrees/{tree}/conversations"].get.parameters
      .map((p) => p.name)
      .filter(Boolean);
    expect(params).toContain("origin");
    expect(params).toContain("agent_id");
  });

  it("generator can seed structures via the public API (feature-spec.md:185, :188)", () => {
    expect(doc.paths["/agenttrees"].post).toBeDefined();
    expect(doc.paths["/agenttrees/{tree}/agents"].post).toBeDefined();
    expect(doc.paths["/eval/rubrics"].post).toBeDefined();
    expect(doc.paths["/agenttrees/{tree}/conversations/{conversationId}"].get).toBeDefined();
  });

  it("stop-generation has defined terminal semantics (feature-spec.md:13)", () => {
    expect(doc.components.schemas.ChatDoneEvent.properties.status.enum).toEqual(["completed", "cancelled"]);
    expect(doc.components.schemas.ChatDoneEvent.required).toContain("status");
  });

  it("frozen replay is pinned in the request schemas (feature-spec.md:77, :82)", () => {
    for (const name of ["ReplayRequest", "ReplayTurnRequest"]) {
      const policy = doc.components.schemas[name].properties.context_policy;
      expect(policy.enum, `${name}.context_policy`).toEqual(["frozen"]);
      expect(policy.default).toBe("frozen");
    }
  });
});
