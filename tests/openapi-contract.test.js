import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import YAML from "yaml";
import SwaggerParser from "@apidevtools/swagger-parser";

const doc = YAML.parse(readFileSync("openapi.yaml", "utf8"));

// feature-spec.md:116-131 filtered to Phase 1 (cupel-phases.md:9-66); tree-scoped
// per feature-spec.md:111, global routes unprefixed.
const PHASE1_PATHS = [
  "/me",
  "/healthz",
  "/models",
  "/agenttrees",
  "/agenttrees/{tree}/endpoints",
  "/agenttrees/{tree}/agents",
  "/agenttrees/{tree}/agents/{agentId}/instructions",
  // The save, relocated off the parent: appending v(n+1) is a creation, so it
  // is POST …/versions and the parent GET is the history (item 7 stage F4).
  "/agenttrees/{tree}/agents/{agentId}/instructions/versions",
  "/agenttrees/{tree}/agents/{agentId}/snapshots",
  "/agenttrees/{tree}/agents/{agentId}/last-selection",
  "/agenttrees/{tree}/conversations",
  "/agenttrees/{tree}/conversations/{conversationId}",
  "/agenttrees/{tree}/chat",
  "/upload",
  "/feedback",
  "/agenttrees/{tree}/replay",
  "/agenttrees/{tree}/replay/turn",
  "/agenttrees/{tree}/evaluations",
  "/agenttrees/{tree}/evaluations/{evaluationId}",
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
  "/eval/evaluations/{evaluationId}/summary",
];

// v0.3.0 additions — feature-spec.md:113-119, :124-130 filtered to Phase 2
// (cupel-phases.md:69-118). Pro-tier repo/PR endpoints excluded (TASKS.md:56);
// /assist is Phase 3 (feature-spec.md:115).
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
  "/eval/cases",
  "/eval/cases/import",
  "/eval/sets",
  "/eval/sets/{setId}",
  "/eval/sets/{setId}/items",
  "/eval/sets/{setId}/freeze",
  "/eval/sets/{setId}/replay",
  "/eval/cases/{caseId}/versions",
  "/eval/sets/{setId}/versions",
  "/eval/rubrics/{rubricId}/versions",
  "/settings",
  // The transcript, split off GET /conversations/{id} so opening a long
  // conversation costs a bounded body (item 7 stage F2).
  "/agenttrees/{tree}/conversations/{conversationId}/turns",
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

  it("tree-scoped resources live under /agenttrees/{tree} (feature-spec.md:111)", () => {
    for (const p of Object.keys(doc.paths)) {
      if (p.includes("{tree}")) {
        expect(p, `${p} must be scoped under /agenttrees/{tree}`).toMatch(
          /^\/agenttrees\/\{tree\}\//
        );
      }
    }
    for (const resource of ["chat", "conversations", "replay", "evaluations"]) {
      expect(doc.paths[`/agenttrees/{tree}/${resource}`]).toBeDefined();
    }
  });

  it("chat serves both modes on one endpoint via a stream flag (cupel-phases.md:43)", () => {
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
    // Instructions: the parent is READ-ONLY and the save is a POST to the
    // version sub-collection — appending v(n+1), never overwriting
    // (feature-spec.md:33), so the verb matches the invariant.
    expect(
      Object.keys(
        doc.paths["/agenttrees/{tree}/agents/{agentId}/instructions"]
      )
    ).toEqual(["get"]);
    expect(
      Object.keys(
        doc.paths["/agenttrees/{tree}/agents/{agentId}/instructions/versions"]
      )
    ).toEqual(["post"]);
  });

  it("soft delete is VISIBLE: a tombstone reads, and there is no restore", () => {
    // The defect this closes: delete was soft in the store and invisible on
    // the wire, so a client could not tell a deleted conversation from an
    // absent one — and the UI was inferring "deleted" from a 404, which is
    // also what an unknown id and an unpermitted tree answer.
    const conv = doc.components.schemas.Conversation;
    expect(conv.required).toContain("deleted");
    expect(conv.properties.deleted.type).toBe("boolean");
    expect(conv.properties.deleted.readOnly).toBe(true);
    // No deleted_at: nothing records WHEN, so a timestamp would be invented.
    expect(conv.properties.deleted_at).toBeUndefined();

    const path = doc.paths["/agenttrees/{tree}/conversations/{conversationId}"];
    // The tombstone reads — GET keeps a 200, and never learned a 410.
    expect(path.get.responses["200"]).toBeDefined();
    expect(path.get.responses["410"]).toBeUndefined();
    // Writes against it conflict; the code is named in the shared response.
    expect(path.patch.responses["409"]).toBeDefined();
    expect(doc.components.responses.Conflict.description).toMatch(/conversation_deleted/);
    // Delete stays idempotent and there is no restore verb. It DOES declare
    // 409 — not for re-deleting a tombstone (that is 204 again, which is what
    // idempotent means here) but because a disabled tree makes its history
    // read-only, so a delete against one is tree_disabled like every other
    // write. The reference implementation has always answered that; only the
    // contract was silent (item 7 stage F7).
    expect(Object.keys(path).sort()).toEqual(["delete", "get", "patch"]);
    expect(path.delete.responses["204"]).toBeDefined();
    expect(path.delete.responses["409"]).toBeDefined();
    expect(doc.paths["/agenttrees/{tree}/conversations/{conversationId}/restore"]).toBeUndefined();
    // And no include_deleted listing: nothing could act on the result.
    const listParams = doc.paths["/agenttrees/{tree}/conversations"].get.parameters.map((p) => p.name);
    expect(listParams).not.toContain("include_deleted");
  });

  it("/me is defined — always called, both auth modes (feature-spec.md:116)", () => {
    expect(doc.paths["/me"].get).toBeDefined();
  });

  // NOTE: the Phase-1 test "no auth anywhere — Phase 1 has no security
  // schemes (cupel-phases.md:10)" is REPLACED by design in v0.3.0. Phase 2
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

  it("task lifecycle and result deep-links (cupel-phases.md:43, feature-spec.md:103)", () => {
    const task = doc.components.schemas.Task.properties;
    expect(task.status.enum).toEqual(["queued", "running", "done", "failed", "cancelled"]);
    // compact + import APPENDED in v0.3.0 — additive, Phase-1 values unchanged
    expect(task.type.enum).toEqual(["chat", "replay", "replay_turn", "judge", "compact", "import"]);
    expect(task.result.properties.evaluation_id).toBeDefined();
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

  it("generator can seed structures via the public API (feature-spec.md:181, :184)", () => {
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

describe("contract v0.4.0", () => {
  it("version is 0.4.0", () => {
    expect(doc.info.version).toBe("0.4.0");
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

  it("Inspector is cross-user, filtered, paginated, audit-logged (cupel-phases.md:78)", () => {
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
    // New versioned stores: the write is POST …/versions (a save mints a
    // version, so it is neither idempotent nor a replacement); no DELETE.
    expect(Object.keys(doc.paths["/eval/cases/{caseId}"])).toEqual(["get"]);
    expect(Object.keys(doc.paths["/eval/sets/{setId}"]).sort()).toEqual(["delete", "get", "patch"]);
    for (const p of [
      "/eval/cases/{caseId}/versions",
      "/eval/sets/{setId}/versions",
      "/eval/rubrics/{rubricId}/versions",
      "/agenttrees/{tree}/agents/{agentId}/instructions/versions",
    ]) {
      expect(Object.keys(doc.paths[p]), `${p} is POST-only`).toEqual(["post"]);
      expect(doc.paths[p].post.responses["201"], `${p} answers 201`).toBeDefined();
      expect(doc.paths[p].post.description, `${p} must document new-version semantics`).toMatch(/version/i);
    }
  });

  it("no PUT anywhere creates a resource — PUT is replacement only", () => {
    // The rule this encodes: a PUT must be idempotent, so it may never answer
    // 201. Every append-only save is POST …/versions above. Left as PUT are
    // the five genuine replacements (settings, the permission matrix, the
    // user upsert keyed by email, last-selection, and the mutable memory
    // document); each answers 200 with the stored state.
    const puts = [];
    for (const [path, item] of Object.entries(doc.paths)) {
      if (item.put) puts.push([path, item.put]);
    }
    expect(puts.map(([p]) => p).sort()).toEqual([
      "/admin/users",
      "/admin/users/{userId}/permissions",
      "/agenttrees/{tree}/agents/{agentId}/last-selection",
      "/agenttrees/{tree}/memory",
      "/settings",
    ]);
    for (const [path, op] of puts) {
      expect(Object.keys(op.responses), `PUT ${path} must not create`).not.toContain("201");
      expect(op.responses["200"], `PUT ${path} echoes the stored state`).toBeDefined();
    }
  });

  it("eval sets carry versioned membership (feature-spec.md:127)", () => {
    const set = doc.components.schemas.EvalSet;
    expect(set.required).toEqual(expect.arrayContaining(["version", "items"]));
    expect(doc.components.schemas.EvalSetUpdate.required).toEqual(["items"]);
    // A rename is metadata, not membership, so PATCH must not be versioned —
    // it is the one write on this resource that answers 200, not 201.
    expect(doc.paths["/eval/sets/{setId}"].patch.responses["200"]).toBeDefined();
    expect(doc.paths["/eval/sets/{setId}"].patch.description).toMatch(/NOT versioned/);
  });

  it("a set member is a live turn reference XOR a frozen case (the Casebook merge)", () => {
    const item = doc.components.schemas.EvalSetItem;
    expect(item.required).toEqual(expect.arrayContaining(["id", "kind"]));
    expect(item.properties.kind.enum).toEqual(["reference", "frozen"]);
    expect(item.properties.source.required).toEqual(["tree", "conversation_id", "turn_id"]);
    expect(item.properties.case_id).toBeDefined();
    expect(doc.components.schemas.EvalSetItemCreate.oneOf.map((b) => b.required.join())).toEqual([
      "source",
      "case_id",
    ]);
    // Materializing is a flip, not a conversion into a second noun: freeze
    // answers the SAME resource, and the old /casebooks routes are gone.
    expect(
      doc.paths["/eval/sets/{setId}/freeze"].post.responses["201"].content["application/json"].schema.$ref
    ).toBe("#/components/schemas/EvalSet");
    expect(
      doc.paths["/eval/sets/{setId}/items"].post.responses["201"].content["application/json"].schema.$ref
    ).toBe("#/components/schemas/EvalSet");
    expect(doc.paths["/eval/sets/{setId}/replay"].post.responses["202"]).toBeDefined();
    expect(Object.keys(doc.paths).filter((p) => p.startsWith("/casebooks"))).toEqual([]);
    expect(Object.keys(doc.components.schemas).filter((s) => s.startsWith("Casebook"))).toEqual([]);
    expect(doc.tags.map((t) => t.name)).not.toContain("casebooks");
  });

  it("JudgeRequest selects by exactly one of evaluation_id / case_ids / set_id (feature-spec.md:129)", () => {
    const judge = doc.components.schemas.JudgeRequest;
    expect(judge.oneOf.map((b) => b.required.join())).toEqual(["evaluation_id", "case_ids", "set_id"]);
    expect(judge.properties.set_id).toBeDefined();
  });

  // Item 7 stage C. The union that lost its argument — four mutually exclusive
  // nullable foreign keys plus a `type` enum — is now a discriminated subject
  // (what was judged) plus a scorer (what produced the score). No backward
  // compatibility: the four keys are GONE, not aliased.
  it("Judgment is a polymorphic subject + scorer, with evaluation_id as scope", () => {
    const judgment = doc.components.schemas.Judgment;
    expect(judgment.required).toEqual(["id", "subject", "scorer", "score", "created_at"]);
    expect(Object.keys(judgment.properties).sort()).toEqual([
      "created_at",
      "evaluation_id",
      "id",
      "reasoning",
      "score",
      "scorer",
      "subject",
    ]);
    expect(judgment.properties.subject.$ref).toBe("#/components/schemas/JudgmentSubject");
    expect(judgment.properties.scorer.$ref).toBe("#/components/schemas/Scorer");
    // evaluation_id is a SCOPE, never a subject: one case scored inside two
    // evaluations must not collapse to one row.
    expect(judgment.properties.evaluation_id.nullable).toBe(true);

    // Declared tight — only what something produces today. Adding `evaluation`
    // (pairwise preference) or `check` later is an enum value, not a reshape.
    const subject = doc.components.schemas.JudgmentSubject;
    expect(subject.required).toEqual(["kind", "id"]);
    expect(subject.properties.kind.enum).toEqual(["case", "turn"]);
    const scorer = doc.components.schemas.Scorer;
    expect(scorer.required).toEqual(["kind"]); // a human thumb carries kind alone
    expect(scorer.properties.kind.enum).toEqual(["llm", "human"]);
    for (const key of ["ref", "version", "model"]) {
      expect(scorer.properties[key].nullable, `scorer.${key}`).toBe(true);
    }

    // The summary aggregates per scorer identity through the SAME schema, so a
    // future non-rubric scorer needs no second shape.
    const summary = doc.components.schemas.EvaluationScoreSummary;
    expect(summary.required).toEqual(["evaluation_id", "scorers"]);
    expect(summary.properties.scorers.items.properties.scorer.$ref).toBe(
      "#/components/schemas/Scorer"
    );

    // listJudgments queries the same vocabulary the response speaks.
    const params = doc.paths["/eval/judgments"].get.parameters.map((p) => p.name);
    expect(params).toEqual([
      "subject_kind",
      "subject_id",
      "evaluation_id",
      "scorer_ref",
      "conversation_id",
      "page",
      "page_size",
    ]);
  });

  it("case creation is handcrafted XOR sourced; import reports per row (feature-spec.md:125-126)", () => {
    const create = doc.components.schemas.EvalCaseCreate;
    expect(create.oneOf.map((b) => b.required.join())).toEqual(["input,output", "source"]);
    const imp = doc.paths["/eval/cases/import"].post;
    const form = imp.requestBody.content["multipart/form-data"].schema;
    expect(form.required).toEqual(["file", "mapping"]);
    expect(imp.responses["200"]).toBeDefined(); // inline per-row report
    expect(imp.responses["202"]).toBeDefined(); // queued for large files
    const report = doc.components.schemas.EvalCaseImportReport;
    expect(report.required).toEqual(expect.arrayContaining(["rows_total", "rows_imported", "errors"]));
    // The per-row report and Error.details are the SAME schema — one shape for
    // "which bit of your input, and why" (item 7 stage F7). The old private
    // copy was {row, column?, message}; column became ErrorDetail.field.
    expect(report.properties.errors.items.$ref).toBe("#/components/schemas/ErrorDetail");
    const detail = doc.components.schemas.ErrorDetail;
    expect(detail.required).toEqual(["message"]);
    expect(Object.keys(detail.properties).sort()).toEqual(["field", "message", "row"]);
  });

  it("context policy widened to frozen/current/custom, Phase-1 defaults preserved (feature-spec.md:77-82)", () => {
    for (const name of ["ReplayRequest", "ReplayTurnRequest", "EvalSetReplayRequest"]) {
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

  it("memory: mutable document + compaction as a queued compact task (feature-spec.md:114)", () => {
    // Mutable by design — the documented exception to the append-only stores
    expect(Object.keys(doc.paths["/agenttrees/{tree}/memory"]).sort()).toEqual(["delete", "get", "put"]);
    const compact = doc.paths["/agenttrees/{tree}/memory/compact"].post;
    expect(compact.responses["202"].content["application/json"].schema.$ref).toBe("#/components/schemas/TaskRef");
    expect(doc.components.schemas.Task.properties.type.enum).toContain("compact");
    // "/chat accepts memory flag" (feature-spec.md:114)
    expect(doc.components.schemas.ChatRequest.properties.memory).toBeDefined();
  });

  it("generator control matches the spec shape (feature-spec.md:118, :185)", () => {
    expect(doc.components.schemas.GeneratorCommand.properties.mode.enum).toEqual(["seed", "drip", "stop"]);
    const status = doc.components.schemas.GeneratorStatus;
    expect(status.required).toEqual(expect.arrayContaining(["mode", "rates", "counts"]));
  });

  it("settings: user-scoped, small, upload limits read-only (feature-spec.md:119)", () => {
    expect(Object.keys(doc.paths["/settings"]).sort()).toEqual(["get", "put"]);
    const settings = doc.components.schemas.Settings;
    expect(settings.properties.upload_limits.readOnly).toBe(true);
    expect(settings.properties.chat_defaults).toBeDefined();
  });

  // Health.storage is the ONLY contract change in that task, and
  // it is additive by construction: a new optional property on an existing
  // response schema. These assertions are what makes "additive" checkable,
  // not just claimed.
  it("Health.storage is optional and additive (P2-PERSIST)", () => {
    const health = doc.components.schemas.Health;
    // required is untouched — a backend that omits storage stays conformant,
    // which is also what cupel-ready compares (scripts/conformance.mjs checks
    // the contract's `required` keys only).
    expect(health.required).toEqual(["status", "version"]);
    const storage = health.properties.storage;
    expect(storage.type).toBe("object");
    expect(storage.properties.mode.enum).toEqual(["local", "s3"]);
    expect(storage.required).toEqual(["mode"]);
    expect(storage.properties.restored.type).toBe("boolean");
  });

  // FeedbackRequest.comment is the ONLY contract change in that
  // task, additive by construction: a new optional property on an existing
  // request schema, so v0.3.0 clients that only send {message_id, rating}
  // remain conformant and the version does not move.
  it("FeedbackRequest.comment is optional and additive (P2-CHATUX)", () => {
    const feedback = doc.components.schemas.FeedbackRequest;
    // required untouched — the comment can never be demanded of a client
    expect(feedback.required).toEqual(["message_id", "rating"]);
    const comment = feedback.properties.comment;
    expect(comment.type).toBe("string");
    expect(comment.nullable).toBe(true);
    // the comment lands on the human judgment's reasoning, not on a Turn
    expect(comment.description).toMatch(/reasoning/);
    expect(doc.components.schemas.Judgment.properties.reasoning.nullable).toBe(true);
    // ...and the thumb store stays append-only: read-only judgment history
    expect(Object.keys(doc.paths["/eval/judgments"])).toEqual(["get"]);
  });

  // ------------------------------------------------------------- families
  // The contract owns the family vocabulary and declares it as its top-level
  // `tags` (see the comment above `tags:` in openapi.yaml). These four tests
  // are what make that a partition instead of a folksonomy: without them a new
  // operation could quietly carry no tag, or two, and `cupel-ready`'s
  // by-family report plus the generator's --family <name>=mine|mock|hide would
  // silently stop covering the whole surface.
  const HTTP_METHODS = ["get", "put", "post", "delete", "options", "head", "patch", "trace"];
  const contractOperations = () =>
    Object.entries(doc.paths).flatMap(([path, item]) =>
      HTTP_METHODS.filter((m) => item[m]).map((m) => ({ id: `${m.toUpperCase()} ${path}`, op: item[m] })));

  it("every operation belongs to exactly one family", () => {
    for (const { id, op } of contractOperations()) {
      expect(op.tags ?? [], `${id} must carry exactly one family tag`).toHaveLength(1);
    }
  });

  it("every family an operation uses is declared, and every declared family is used", () => {
    const declared = doc.tags.map((t) => t.name);
    expect(new Set(declared).size, "duplicate tag declaration").toBe(declared.length);
    const used = new Set(contractOperations().map(({ op }) => op.tags[0]));
    expect([...used].filter((n) => !declared.includes(n))).toEqual([]);
    expect(declared.filter((n) => !used.has(n))).toEqual([]);
  });

  it("every declared family carries a description an adopter can answer from", () => {
    for (const tag of doc.tags) {
      expect(tag.description, `tag ${tag.name} needs a description`).toBeTruthy();
    }
  });

  it("Health can report the contract version and per-family capabilities (C11)", () => {
    const health = doc.components.schemas.Health.properties;
    expect(health.contract_version.type).toBe("string");
    // Additive: neither is required, so a backend that omits both stays conformant.
    expect(doc.components.schemas.Health.required).toEqual(["status", "version"]);
    expect(health.capabilities.additionalProperties.$ref).toBe("#/components/schemas/Capability");
    const capability = doc.components.schemas.Capability;
    expect(capability.required).toEqual(["status"]);
    expect(capability.properties.status.enum).toEqual(["full", "partial", "none"]);
  });

  // -------------------------------------------------- permissions (F5)
  // The contract declares, per operation, the ONE capability its caller must
  // hold — `x-requires` written on the operation itself, for the same reason
  // the family tag is (see the PERMISSIONS comment in openapi.yaml). These
  // tests are what make it a partition rather than a wish: without them an
  // operation could ship with no declaration, or declare `tune` and quietly
  // never answer 403, and the difference between "hidden" and "refused" —
  // the whole point of the split — would rot.
  const REQUIREMENTS = ["none", "view", "tune", "evaluate", "admin", "inspect"];
  // The two failures, kept apart: view is a precondition of the PATH and its
  // absence is 404 (existence-hiding); everything else is a capability and its
  // absence is 403 (explained).
  const HIDDEN = ["none", "view"];
  const EXPLAINED = ["tune", "evaluate", "admin", "inspect"];

  it("every operation declares exactly one permission requirement", () => {
    for (const { id, op } of contractOperations()) {
      expect(REQUIREMENTS, `${id} must declare x-requires`).toContain(op["x-requires"]);
    }
  });

  it("a tree permission is only ever required by a tree-scoped operation", () => {
    // view/tune/evaluate are per-tree (Me.permissions is keyed by tree id), so
    // requiring one where the path names no tree would be unenforceable.
    for (const { id, op } of contractOperations()) {
      if (!["view", "tune", "evaluate"].includes(op["x-requires"])) continue;
      expect(id, `${id} requires a per-tree permission`).toMatch(/ \/agenttrees\/\{tree\}\//);
    }
    // …and conversely every tree-scoped operation requires one: a path that
    // hangs off {tree} can never be `none`, or the scope would buy nothing.
    for (const { id, op } of contractOperations()) {
      if (!/ \/agenttrees\/\{tree\}\//.test(id)) continue;
      expect(["view", "tune", "evaluate"], `${id}`).toContain(op["x-requires"]);
    }
  });

  it("403 is declared by exactly the operations whose refusal is EXPLAINED", () => {
    for (const { id, op } of contractOperations()) {
      const requires = op["x-requires"];
      const declared = "403" in (op.responses ?? {});
      expect(declared, `${id} requires ${requires}, 403 declared=${declared}`).toBe(
        EXPLAINED.includes(requires),
      );
    }
    // The negative half stated as itself: a `view` operation must never answer
    // 403, because doing so would confirm the tree exists to a caller who is
    // supposed to be unable to tell.
    for (const { id, op } of contractOperations()) {
      if (!HIDDEN.includes(op["x-requires"])) continue;
      expect(op.responses?.["403"], `${id} must hide, not explain`).toBeUndefined();
    }
    // 404 stays the answer for an unpermitted tree, said at the shared response.
    expect(doc.components.responses.NotFound.description).toMatch(/not permitted/i);
    expect(doc.components.responses.Forbidden.description).toMatch(/x-requires/);
    expect(doc.components.responses.Forbidden.description).toMatch(/Never answered for a missing view/);
  });

  it("the headline case is declared: saving instructions requires tune", () => {
    // The bug this closes: a user with view but not tune got something that
    // looked like a backend fault when they pressed Save.
    const save = doc.paths["/agenttrees/{tree}/agents/{agentId}/instructions/versions"].post;
    expect(save["x-requires"]).toBe("tune");
    expect(save.responses["403"].$ref).toBe("#/components/responses/Forbidden");
    // …while READING them is view, so a viewer still sees what the agent says.
    expect(doc.paths["/agenttrees/{tree}/agents/{agentId}/instructions"].get["x-requires"]).toBe(
      "view",
    );
  });

  // ---------------------------------------------------------- collections
  // ONE collection shape (see the Collections rule in info.description and the
  // comment above ConversationPage). OpenAPI 3.0 cannot express Page<T>, so
  // the four keys are repeated per type — these three tests are what stop the
  // copies from drifting and what stops a fifth unpaged listing appearing by
  // habit.
  const PAGE_KEYS = ["items", "page", "page_size", "total"];

  // The four bare-array 200s that are NOT collections of user data, each with
  // the reason it is exempt written at its own response in openapi.yaml.
  const UNPAGED = new Set([
    "GET /models", // backend-configured dropdown enumeration
    "GET /agenttrees", // the scope selector every other path hangs off
    "GET /agenttrees/{tree}/endpoints", // backend-configured multiselect
    "GET /agenttrees/{tree}/agents", // a hierarchy — a page of it orphans nodes
    "PUT /admin/users", // write echo: exactly the rows the body named
  ]);

  it("a conversation does not inline its transcript (item 7 stage F2)", () => {
    const conversation = doc.components.schemas.Conversation;
    expect(conversation.properties.turns, "turns must not be inlined").toBeUndefined();
    // The count stays, so a caller can size or skip the transcript fetch.
    expect(conversation.required).toContain("turn_count");
    const turns = doc.paths["/agenttrees/{tree}/conversations/{conversationId}/turns"].get;
    expect(turns.responses["200"].content["application/json"].schema.$ref).toBe(
      "#/components/schemas/TurnPage",
    );
    // Chronological + no `page` default is what makes page 1 immutable here:
    // a transcript only grows at the tail, and omitting page means the tail.
    const page = turns.parameters.find((p) => p.name === "page");
    expect(page.schema.default, "page must NOT default to 1 — omitted means last").toBeUndefined();
    expect(turns.description).toMatch(/oldest first/);
    expect(turns.parameters.map((p) => p.name)).toContain("turn_ids");
  });

  it("the evaluation grid is paged by row and revalidates with an ETag (item 7 stage F3)", () => {
    const op = doc.paths["/agenttrees/{tree}/evaluations/{evaluationId}"].get;
    const params = op.parameters.map((p) => p.name);
    expect(params).toEqual(expect.arrayContaining(["page", "page_size", "If-None-Match"]));
    // Rows are a page; columns deliberately are not — they are the caller's
    // own configs and every row needs all of them to be readable.
    const evaluation = doc.components.schemas.Evaluation;
    expect(evaluation.properties.rows.allOf[0].$ref).toBe(
      "#/components/schemas/EvaluationRowPage",
    );
    expect(evaluation.properties.columns.type).toBe("array");
    // The 304 is the point of the ETag: an unchanged grid must cost no body.
    expect(op.responses["304"]).toBeTruthy();
    expect(op.responses["304"].content, "304 must carry no body").toBeUndefined();
    for (const status of ["200", "304"]) {
      expect(op.responses[status].headers.ETag, `${status} must return the validator`).toBeTruthy();
    }
  });

  it("every *Page schema is the same four-key envelope", () => {
    const pages = Object.entries(doc.components.schemas).filter(([n]) => n.endsWith("Page"));
    expect(pages.length, "no page schemas found — did they get renamed?").toBeGreaterThan(5);
    for (const [name, schema] of pages) {
      expect(schema.type, `${name}.type`).toBe("object");
      expect([...(schema.required ?? [])].sort(), `${name}.required`).toEqual([...PAGE_KEYS].sort());
      expect(Object.keys(schema.properties ?? {}).sort(), `${name} properties`).toEqual(
        [...PAGE_KEYS].sort(),
      );
      expect(schema.properties.items.type, `${name}.items`).toBe("array");
      for (const key of ["page", "page_size", "total"]) {
        expect(schema.properties[key].type, `${name}.${key}`).toBe("integer");
      }
    }
  });

  it("no collection returns a bare array outside the documented exemptions", () => {
    for (const { id, op } of contractOperations()) {
      for (const [status, res] of Object.entries(op.responses ?? {})) {
        const schema = res.content?.["application/json"]?.schema;
        if (!schema || schema.type !== "array") continue;
        expect(UNPAGED.has(id), `${id} ${status} returns a bare array — page it or exempt it`).toBe(
          true,
        );
      }
    }
  });

  it("every paged operation takes page + page_size, and every exemption says why", () => {
    for (const { id, op } of contractOperations()) {
      const ref = op.responses?.["200"]?.content?.["application/json"]?.schema?.$ref ?? "";
      if (!ref.endsWith("Page")) continue;
      const params = (op.parameters ?? []).map((p) => p.name);
      expect(params, `${id} needs page`).toContain("page");
      expect(params, `${id} needs page_size`).toContain("page_size");
    }
    for (const id of UNPAGED) {
      const [method, path] = id.split(" ");
      const op = doc.paths[path][method.toLowerCase()];
      const text = JSON.stringify(op.responses["200"].description ?? "");
      expect(text, `${id} must say why it is not paged`).toMatch(/NOT paged|write ECHO/);
    }
  });

  // ------------------------------------------------------- errors (F7)
  // The defect these close: an error was {code, message} and nothing else —
  // no machine-readable detail, no correlation id — and several statuses the
  // implementations return freely (422 above all, plus 409 tree_disabled on
  // six write operations) were declared nowhere, so a client could not know
  // they existed and cupel-ready could not check them.
  const resolveResponse = (res) => {
    if (!res?.$ref) return res;
    return doc.components.responses[res.$ref.replace("#/components/responses/", "")];
  };

  it("every non-2xx response is the ONE Error schema", () => {
    for (const { id, op } of contractOperations()) {
      for (const [status, raw] of Object.entries(op.responses ?? {})) {
        if (status.startsWith("2") || status === "304") continue;
        const schema = resolveResponse(raw)?.content?.["application/json"]?.schema;
        expect(schema?.$ref, `${id} ${status} must answer the Error schema`).toBe(
          "#/components/schemas/Error",
        );
      }
    }
  });

  it("Error carries a request_id and optional details[]; details is ErrorDetail", () => {
    const error = doc.components.schemas.Error;
    expect(error.required).toEqual(["code", "message", "request_id"]);
    expect(error.properties.request_id.type).toBe("string");
    // details is OPTIONAL — a 404 has nothing to point at, and a required
    // empty array would be noise on every such body.
    expect(error.required).not.toContain("details");
    expect(error.properties.details.items.$ref).toBe("#/components/schemas/ErrorDetail");
    // Deliberately NOT RFC 9457: no problem+json media type anywhere, and no
    // type/title/instance members (see the Errors note in info.description).
    for (const name of ["type", "title", "instance", "status"]) {
      expect(error.properties[name], `Error.${name} is RFC 9457 ceremony`).toBeUndefined();
    }
    const mediaTypes = new Set();
    for (const { op } of contractOperations()) {
      for (const raw of Object.values(op.responses ?? {})) {
        for (const type of Object.keys(resolveResponse(raw)?.content ?? {})) mediaTypes.add(type);
      }
    }
    expect([...mediaTypes]).not.toContain("application/problem+json");
  });

  it("every shared error response exposes X-Request-Id", () => {
    for (const [name, res] of Object.entries(doc.components.responses)) {
      const schema = res.content?.["application/json"]?.schema;
      if (schema?.$ref !== "#/components/schemas/Error") continue;
      expect(res.headers?.["X-Request-Id"], `${name} must expose X-Request-Id`).toBeDefined();
    }
  });

  it("422 is declared wherever a body or a typed query parameter can be rejected", () => {
    for (const [path, item] of Object.entries(doc.paths)) {
      for (const method of HTTP_METHODS) {
        const op = item[method];
        if (!op) continue;
        const params = [...(item.parameters ?? []), ...(op.parameters ?? [])].map((p) =>
          p.$ref ? doc.components.parameters[p.$ref.replace("#/components/parameters/", "")] : p,
        );
        // A path parameter is part of the URL — a bad one is a 404, not a 422.
        const typedQuery = params.some(
          (p) => p.in === "query" && ["integer", "number", "boolean"].includes(p.schema?.type),
        );
        const declared = "422" in (op.responses ?? {});
        const expected = Boolean(op.requestBody) || typedQuery;
        expect(declared, `${method.toUpperCase()} ${path} 422 declared=${declared}`).toBe(expected);
      }
    }
  });

  it("429 is declared exactly on the operations that can start live generation", () => {
    const live = contractOperations()
      .filter(({ op }) => "429" in (op.responses ?? {}))
      .map(({ id }) => id)
      .sort();
    expect(live).toEqual([
      "POST /agenttrees/{tree}/chat",
      "POST /agenttrees/{tree}/replay",
      "POST /agenttrees/{tree}/replay/turn",
      "POST /eval/judge",
      "POST /eval/sets/{setId}/replay",
    ]);
    const res = doc.components.responses.TooManyRequests;
    expect(res.headers["Retry-After"]).toBeDefined();
  });

  it("no 5xx is declared anywhere — a server fault is not a specified outcome", () => {
    for (const { id, op } of contractOperations()) {
      for (const status of Object.keys(op.responses ?? {})) {
        expect(status.startsWith("5"), `${id} declares ${status}`).toBe(false);
      }
    }
  });

  // ------------------------------------------------------ search (F8)
  it("?search= says what it matches — substring, case, fields, composition", () => {
    // The defect this closes: the parameter existed with a bare
    // `{type: string}` and no description at all, so two conformant backends
    // could disagree on every axis of it and cupel-ready had nothing to check.
    const op = doc.paths["/agenttrees/{tree}/conversations"].get;
    const search = op.parameters.find((p) => p.name === "search");
    const text = search.description ?? "";
    // Each clause is load-bearing; a rewrite that drops one re-opens the gap.
    expect(text, "substring, not tokens").toMatch(/SUBSTRING, not tokens/);
    expect(text, "the whole value is one substring").toMatch(/WHOLE parameter is one substring/);
    expect(text, "case-insensitivity, beyond ASCII").toMatch(/CASE-INSENSITIVE/);
    expect(text, "no wildcards").toMatch(/LITERAL/);
    // The field list is the half the two implementations actually disagreed
    // on — MSW searched titles only while the reference searched turns too.
    expect(text, "which fields").toMatch(/FIELDS:/);
    expect(text, "turn content is searched").toMatch(/content` of any turn/);
    expect(text, "a hit answers with the conversation").toMatch(/never the turn/);
    expect(text, "ANDs with the other filters").toMatch(/ANDs with every other parameter/);
    expect(text, "narrows before paging").toMatch(/BEFORE paging/);
    expect(text, "forks are only reachable via forks_of").toMatch(/forks_of/);
    expect(text, "empty means absent, not 'match nothing'").toMatch(/as if the parameter were/);

    // …and it is the ONLY free-text search in the contract. The Inspector
    // filters by user/tree/date/score, not by text, so there is no second
    // search whose semantics could drift from this one.
    const searches = contractOperations().flatMap(({ id, op: o }) =>
      (o.parameters ?? []).filter((p) => p.name === "search").map(() => id),
    );
    expect(searches).toEqual(["GET /agenttrees/{tree}/conversations"]);
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
