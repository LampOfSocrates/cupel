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

// v0.3.0 additions — feature-spec.md:117-123, :128-134 filtered to Phase 2
// (skein-phases.md:69-118). Pro-tier repo/PR endpoints excluded (TASKS.md:56);
// /assist is Phase 3 (feature-spec.md:119).
const PHASE2_PATHS = [
  "/auth/token",
  "/auth/logout",
  "/admin/users",
  "/admin/users/{userId}/permissions",
  "/admin/agenttrees/{treeId}",
  "/admin/conversations",
  "/admin/generator",
  "/admin/generator/status",
  "/agenttrees/{tree}/memory",
  "/agenttrees/{tree}/memory/compact",
  "/casebooks",
  "/casebooks/{casebookId}",
  "/casebooks/{casebookId}/items",
  "/casebooks/{casebookId}/items/{itemId}",
  "/casebooks/{casebookId}/to-eval-set",
  "/casebooks/{casebookId}/replay",
  "/eval/cases",
  "/eval/cases/import",
  "/eval/sets",
  "/eval/sets/{setId}",
  "/eval/rubrics/{rubricId}",
  "/settings",
];

describe("P1-T00 OpenAPI contract", () => {
  it("is valid OpenAPI 3.0 (refs resolve, schemas well-formed)", async () => {
    await SwaggerParser.validate("openapi.yaml");
  });

  it("defines exactly the Phase-1 + Phase-2 endpoints", () => {
    expect(Object.keys(doc.paths).sort()).toEqual(
      [...PHASE1_PATHS, ...PHASE2_PATHS].sort()
    );
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

  // NOTE: the Phase-1 test "no auth anywhere — Phase 1 has no security
  // schemes (skein-phases.md:10)" is REPLACED by design in v0.3.0. Phase 2
  // introduces the bearerAuth security model (feature-spec.md:15-21), so the
  // old assertion inverts into the security-model tests in the
  // "P2-T00 contract v0.3.0" block below.

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
    // compact + import APPENDED in v0.3.0 — additive, Phase-1 values unchanged
    expect(task.type.enum).toEqual(["chat", "replay", "replay_turn", "judge", "compact", "import"]);
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

  it("frozen replay stays the default after the v0.3.0 widening (feature-spec.md:77, :82)", () => {
    for (const name of ["ReplayRequest", "ReplayTurnRequest"]) {
      const policy = doc.components.schemas[name].properties.context_policy;
      // Phase 1 pinned enum [frozen]; v0.3.0 widens the enum but preserves
      // the default, so Phase-1 requests remain valid and behave unchanged.
      expect(policy.default, `${name}.context_policy default`).toBe("frozen");
    }
  });
});

describe("P2-T00 contract v0.3.0", () => {
  it("version is 0.3.0", () => {
    expect(doc.info.version).toBe("0.3.0");
  });

  it("security model: bearer JWT gates everything by default (feature-spec.md:15-21)", () => {
    const scheme = doc.components.securitySchemes.bearerAuth;
    expect(scheme.type).toBe("http");
    expect(scheme.scheme).toBe("bearer");
    expect(scheme.bearerFormat).toBe("JWT");
    expect(doc.security).toEqual([{ bearerAuth: [] }]);
  });

  it("exactly /healthz and /auth/token are open (security: [])", () => {
    const overrides = [];
    for (const [p, methods] of Object.entries(doc.paths)) {
      for (const [method, op] of Object.entries(methods)) {
        if (op.security !== undefined) {
          expect(op.security, `${method.toUpperCase()} ${p} override must be open, not re-scoped`).toEqual([]);
          overrides.push(`${method} ${p}`);
        }
      }
    }
    expect(overrides.sort()).toEqual(["get /healthz", "post /auth/token"]);
  });

  it("401 is spelled out on /me, /auth/logout and every /admin operation", () => {
    expect(doc.paths["/me"].get.responses["401"]).toBeDefined();
    expect(doc.paths["/auth/logout"].post.responses["401"]).toBeDefined();
    for (const [p, methods] of Object.entries(doc.paths)) {
      if (!p.startsWith("/admin/")) continue;
      for (const [method, op] of Object.entries(methods)) {
        expect(op.responses["401"], `${method.toUpperCase()} ${p} must declare 401`).toBeDefined();
      }
    }
  });

  it("auth endpoints return a JWT + user; logout is a plain 204 (feature-spec.md:18)", () => {
    const res = doc.components.schemas.AuthTokenResponse;
    expect(res.required).toEqual(expect.arrayContaining(["access_token", "token_type", "me"]));
    expect(res.properties.me.$ref).toBe("#/components/schemas/Me");
    expect(doc.components.schemas.AuthTokenRequest.required).toEqual(["email", "password"]);
    expect(doc.paths["/auth/logout"].post.responses["204"]).toBeDefined();
  });

  it("admin: users, per-tree permission matrix, tree toggle (feature-spec.md:19-20)", () => {
    expect(Object.keys(doc.paths["/admin/users"]).sort()).toEqual(["get", "put"]);
    expect(Object.keys(doc.paths["/admin/users/{userId}/permissions"]).sort()).toEqual(["get", "put"]);
    expect(Object.keys(doc.paths["/admin/agenttrees/{treeId}"])).toEqual(["patch"]);
    expect(doc.components.schemas.TreeToggleRequest.required).toEqual(["enabled"]);
    // matrix mirrors Me.permissions: per-tree view/tune/evaluate
    const matrix = doc.components.schemas.PermissionMatrix.properties.permissions;
    expect(matrix.additionalProperties.items.enum).toEqual(["view", "tune", "evaluate"]);
  });

  it("disabling a tree 409s new work with tree_disabled (feature-spec.md:20)", () => {
    for (const [p, method] of [
      ["/agenttrees/{tree}/chat", "post"],
      ["/agenttrees/{tree}/replay", "post"],
      ["/agenttrees/{tree}/replay/turn", "post"],
      ["/eval/judge", "post"],
    ]) {
      expect(doc.paths[p][method].responses["409"], `${method.toUpperCase()} ${p} must declare 409`).toBeDefined();
    }
    expect(doc.components.responses.Conflict.description).toMatch(/tree_disabled/);
  });

  it("Inspector is cross-user, filtered, paginated, audit-logged (skein-phases.md:78)", () => {
    const params = doc.paths["/admin/conversations"].get.parameters.map((p) => p.name);
    for (const name of ["user_id", "tree", "date_from", "date_to", "score_min", "score_max", "page", "page_size"]) {
      expect(params, `filter ${name}`).toContain(name);
    }
    expect(doc.paths["/admin/conversations"].get.description).toMatch(/audit-logged/);
  });

  it("append-only holds in v0.3.0: versioned saves, no destructive verbs", () => {
    // Phase-1 append-only stores unchanged
    expect(Object.keys(doc.paths["/eval/judgments"])).toEqual(["get"]);
    expect(Object.keys(doc.paths["/agenttrees/{tree}/agents/{agentId}/snapshots"])).toEqual(["post"]);
    // New versioned stores: PUT = new version, never overwrite; no DELETE
    expect(Object.keys(doc.paths["/eval/cases/{caseId}"]).sort()).toEqual(["get", "put"]);
    expect(Object.keys(doc.paths["/eval/sets/{setId}"])).toEqual(["put"]);
    expect(Object.keys(doc.paths["/eval/rubrics/{rubricId}"])).toEqual(["put"]);
    for (const p of ["/eval/cases/{caseId}", "/eval/sets/{setId}", "/eval/rubrics/{rubricId}"]) {
      expect(doc.paths[p].put.description, `${p} PUT must document new-version semantics`).toMatch(/new version/i);
    }
  });

  it("eval sets carry versioned membership (feature-spec.md:131)", () => {
    const set = doc.components.schemas.EvalSet;
    expect(set.required).toEqual(expect.arrayContaining(["version", "case_ids"]));
    expect(doc.components.schemas.EvalSetUpdate.required).toEqual(["case_ids"]);
  });

  it("JudgeRequest selects by exactly one of run_id / case_ids / set_id (feature-spec.md:133)", () => {
    const judge = doc.components.schemas.JudgeRequest;
    expect(judge.oneOf.map((b) => b.required.join())).toEqual(["run_id", "case_ids", "set_id"]);
    expect(judge.properties.set_id).toBeDefined();
  });

  it("case creation is handcrafted XOR sourced; import reports per row (feature-spec.md:129-130)", () => {
    const create = doc.components.schemas.EvalCaseCreate;
    expect(create.oneOf.map((b) => b.required.join())).toEqual(["input,output", "source"]);
    const imp = doc.paths["/eval/cases/import"].post;
    const form = imp.requestBody.content["multipart/form-data"].schema;
    expect(form.required).toEqual(["file", "mapping"]);
    expect(imp.responses["200"]).toBeDefined(); // inline per-row report
    expect(imp.responses["202"]).toBeDefined(); // queued for large files
    const report = doc.components.schemas.EvalCaseImportReport;
    expect(report.required).toEqual(expect.arrayContaining(["rows_total", "rows_imported", "errors"]));
    expect(report.properties.errors.items.required).toEqual(["row", "message"]);
  });

  it("context policy widened to frozen/current/custom, Phase-1 defaults preserved (feature-spec.md:77-82)", () => {
    for (const name of ["ReplayRequest", "ReplayTurnRequest", "CasebookReplayRequest"]) {
      const props = doc.components.schemas[name].properties;
      expect(props.context_policy.enum, `${name}.context_policy`).toEqual(["frozen", "current", "custom"]);
      expect(props.context_policy.default).toBe("frozen");
      expect(props.context_override, `${name}.context_override`).toBeDefined();
      expect(props.fallback_policy.enum).toEqual(["settings", "error"]);
      expect(props.fallback_policy.default).toBe("settings");
      expect(props.tools_mode.enum, `${name}.tools_mode`).toEqual(["live", "replay_recorded"]);
      expect(props.tools_mode.default).toBe("live");
    }
    // the settings-level fallback envelope the "settings" policy consumes (feature-spec.md:81)
    expect(doc.components.schemas.Settings.properties.fallback_envelope).toBeDefined();
  });

  it("memory: mutable document + compaction as a queued compact task (feature-spec.md:118)", () => {
    // Mutable by design — the documented exception to the append-only stores
    expect(Object.keys(doc.paths["/agenttrees/{tree}/memory"]).sort()).toEqual(["delete", "get", "put"]);
    const compact = doc.paths["/agenttrees/{tree}/memory/compact"].post;
    expect(compact.responses["202"].content["application/json"].schema.$ref).toBe("#/components/schemas/TaskRef");
    expect(doc.components.schemas.Task.properties.type.enum).toContain("compact");
    // "/chat accepts memory flag" (feature-spec.md:118)
    expect(doc.components.schemas.ChatRequest.properties.memory).toBeDefined();
  });

  it("casebooks: items are turn references; to-eval-set and replay exist (feature-spec.md:117)", () => {
    expect(Object.keys(doc.paths["/casebooks"]).sort()).toEqual(["get", "post"]);
    expect(Object.keys(doc.paths["/casebooks/{casebookId}"]).sort()).toEqual(["delete", "get", "patch"]);
    expect(doc.components.schemas.CasebookItem.required).toEqual(
      expect.arrayContaining(["tree", "conversation_id", "turn_id"])
    );
    expect(
      doc.paths["/casebooks/{casebookId}/to-eval-set"].post.responses["201"].content["application/json"].schema.$ref
    ).toBe("#/components/schemas/EvalSet");
    expect(doc.paths["/casebooks/{casebookId}/replay"].post.responses["202"]).toBeDefined();
  });

  it("generator control matches the spec shape (feature-spec.md:122, :189)", () => {
    expect(doc.components.schemas.GeneratorCommand.properties.mode.enum).toEqual(["seed", "drip", "stop"]);
    const status = doc.components.schemas.GeneratorStatus;
    expect(status.required).toEqual(expect.arrayContaining(["mode", "rates", "counts"]));
  });

  it("settings: user-scoped, small, upload limits read-only (feature-spec.md:123)", () => {
    expect(Object.keys(doc.paths["/settings"]).sort()).toEqual(["get", "put"]);
    const settings = doc.components.schemas.Settings;
    expect(settings.properties.upload_limits.readOnly).toBe(true);
    expect(settings.properties.chat_defaults).toBeDefined();
  });

  // P2-PERSIST — Health.storage is the ONLY contract change in that task, and
  // it is additive by construction: a new optional property on an existing
  // response schema. These assertions are what makes "additive" checkable,
  // not just claimed.
  it("Health.storage is optional and additive (P2-PERSIST)", () => {
    const health = doc.components.schemas.Health;
    // required is untouched — a backend that omits storage stays conformant,
    // which is also what skein-ready compares (scripts/conformance.mjs checks
    // the contract's `required` keys only).
    expect(health.required).toEqual(["status", "version"]);
    const storage = health.properties.storage;
    expect(storage.type).toBe("object");
    expect(storage.properties.mode.enum).toEqual(["local", "s3"]);
    expect(storage.required).toEqual(["mode"]);
    expect(storage.properties.restored.type).toBe("boolean");
  });

  it("NO pro-tier endpoints: repo/PR integration excluded (TASKS.md:56); /assist is Phase 3", () => {
    for (const p of Object.keys(doc.paths)) {
      expect(p.startsWith("/settings/repo"), `${p} — /settings/repo is pro tier`).toBe(false);
      expect(p.startsWith("/webhooks"), `${p} — git webhooks are pro tier`).toBe(false);
      expect(/\/pr$/.test(p), `${p} — PR endpoints are pro tier`).toBe(false);
      expect(p.startsWith("/assist"), `${p} — /assist is Phase 3`).toBe(false);
    }
  });
});
