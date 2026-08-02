import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import YAML from "yaml";
import SwaggerParser from "@apidevtools/swagger-parser";

const doc = YAML.parse(readFileSync("openapi.yaml", "utf8"));

// feature-spec.md:120-135 filtered to Phase 1 (loom-phases.md:9-66); tree-scoped
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

  it("chat serves both modes on one endpoint via a stream flag (loom-phases.md:43)", () => {
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
});
