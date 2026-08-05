// skein-ready comparator engine (P2-READY, skein-phases.md:74).
// Compares a DEREFERENCED contract OpenAPI doc against a DEREFERENCED target
// doc, contract -> target direction only (extra target paths are ignored).
//
// Depth of the checks (deliberately shallow — deep JSON-Schema diffing is out
// of scope, docs/readiness.md):
//   - operation presence: contract path+method must exist in the target;
//     path templates match exactly, with a positional fallback ({tree} vs
//     {tree_id}) so renamed path params surface as param mismatches, not
//     blunt "missing path".
//   - parameters (in: path|query only): each contract param must exist in the
//     target by name+in; contract required=true must be required in target.
//   - requestBody: content types must overlap WHEN BOTH SIDES declare a body.
//     A target without a declared body (e.g. FastAPI handlers reading the raw
//     Request) is tolerated — a loose spec is not a wrong one.
//   - responses: the contract's primary success code (lowest 2xx) must be
//     declared; its content types must overlap when both declare content.
//     Error codes (4xx/5xx) are NOT required — most generators don't emit them.
//   - schemas: shallow structural check only — when both sides declare a JSON
//     schema for the success response, every `required` key of the contract's
//     (object) schema must appear among the target schema's properties.
//     Empty/loose target schemas (no properties) skip the check.
// Security declarations are ignored entirely: gated targets are reached via
// --header pass-through, auth flows are out of scope for this script.

// Phase-1 surface for --phase1-only, maintained-list approach (mirrors
// PHASE1_PATHS in tests/openapi-contract.test.js — a tag heuristic was
// rejected because contract tags group by resource, not by phase). The
// vitest suite guards drift: this list must be a subset of contract paths.
export const PHASE1_PATHS = [
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

// v0.3.0 added Phase-2 METHODS onto Phase-1 paths in one place: the versioned
// PUT on /eval/cases/{caseId} (contract "P2-T00" — append-only case saves).
// --phase1-only must therefore filter per operation, not just per path: only
// the methods listed here count as Phase 1 for that path (unlisted paths
// include all their contract methods).
export const PHASE1_METHODS = {
  "/eval/cases/{caseId}": ["get"],
};

const HTTP_METHODS = ["get", "put", "post", "delete", "options", "head", "patch", "trace"];

const normalizeTemplate = (path) => path.replace(/\{[^}]*\}/g, "{}");

function mergedParams(pathItem, op) {
  const key = (p) => `${p.in}:${p.name}`;
  const map = new Map();
  for (const p of pathItem?.parameters ?? []) map.set(key(p), p);
  for (const p of op?.parameters ?? []) map.set(key(p), p); // op-level wins
  return [...map.values()];
}

const contentTypes = (body) => Object.keys(body?.content ?? {});

function primarySuccess(responses) {
  const codes = Object.keys(responses ?? {}).filter((c) => /^2\d\d$/.test(c));
  return codes.sort()[0] ?? null;
}

function jsonSchema(response) {
  const content = response?.content ?? {};
  const ct = Object.keys(content).find((k) => k.includes("json"));
  return ct ? content[ct].schema : undefined;
}

// Unwrap array wrappers so list endpoints compare their item shapes.
function objectSchema(schema) {
  if (!schema || typeof schema !== "object") return null;
  if (schema.items && (schema.type === "array" || !schema.properties)) {
    return objectSchema(schema.items);
  }
  return schema;
}

function shallowSchemaProblems(contractSchema, targetSchema) {
  const c = objectSchema(contractSchema);
  const t = objectSchema(targetSchema);
  const required = c?.required ?? [];
  const props = t?.properties ?? {};
  // Loose target (no declared properties) or unconstrained contract: skip.
  if (!required.length || !Object.keys(props).length) return [];
  const missing = required.filter((k) => !(k in props));
  return missing.length
    ? [`response schema lacks required key(s): ${missing.join(", ")}`]
    : [];
}

function checkOperation(path, method, pathItem, op, targetPath, targetItem) {
  const targetOp = targetItem[method];
  if (!targetOp) {
    const declared = HTTP_METHODS.filter((m) => targetItem[m]);
    return {
      status: "missing",
      problems: [`method not declared on ${targetPath} (target has: ${declared.join(", ") || "none"})`],
    };
  }

  const problems = [];
  const targetParams = mergedParams(targetItem, targetOp);
  for (const p of mergedParams(pathItem, op)) {
    if (p.in !== "path" && p.in !== "query") continue;
    const match = targetParams.find((tp) => tp.name === p.name && tp.in === p.in);
    if (!match) {
      const hint = p.in === "path" && targetPath !== path ? ` (target path is ${targetPath})` : "";
      problems.push(`param '${p.name}' (${p.in}) missing${hint}`);
    } else if (p.required && !match.required) {
      problems.push(`param '${p.name}' (${p.in}) must be required`);
    }
  }

  const cBody = contentTypes(op.requestBody);
  const tBody = contentTypes(targetOp.requestBody);
  if (cBody.length && tBody.length && !cBody.some((ct) => tBody.includes(ct))) {
    problems.push(`request content types disjoint (contract: ${cBody.join(", ")}; target: ${tBody.join(", ")})`);
  }

  const success = primarySuccess(op.responses);
  if (success) {
    const targetResponse = (targetOp.responses ?? {})[success];
    if (!targetResponse) {
      const declared = Object.keys(targetOp.responses ?? {});
      problems.push(`success response ${success} not declared (target declares: ${declared.join(", ") || "none"})`);
    } else {
      const cCT = contentTypes(op.responses[success]);
      const tCT = contentTypes(targetResponse);
      if (cCT.length && tCT.length && !cCT.some((ct) => tCT.includes(ct))) {
        problems.push(`response ${success} content types disjoint (contract: ${cCT.join(", ")}; target: ${tCT.join(", ")})`);
      } else {
        problems.push(...shallowSchemaProblems(jsonSchema(op.responses[success]), jsonSchema(targetResponse)));
      }
    }
  }

  return { status: problems.length ? "mismatch" : "ok", problems };
}

/**
 * @param {object} contract dereferenced contract OpenAPI document
 * @param {object} target dereferenced target OpenAPI document
 * @param {{prefix?: string, phase1Only?: boolean}} options
 */
export function compare(contract, target, { prefix = "", phase1Only = false } = {}) {
  const targetPaths = target.paths ?? {};
  const byTemplate = new Map();
  for (const p of Object.keys(targetPaths)) byTemplate.set(normalizeTemplate(p), p);

  const operations = [];
  for (const path of Object.keys(contract.paths ?? {}).sort()) {
    if (phase1Only && !PHASE1_PATHS.includes(path)) continue;
    const pathItem = contract.paths[path];
    const lookup = prefix + path;
    const targetPath = targetPaths[lookup]
      ? lookup
      : byTemplate.get(normalizeTemplate(lookup)) ?? null;

    for (const method of HTTP_METHODS) {
      const op = pathItem[method];
      if (!op) continue;
      if (phase1Only && PHASE1_METHODS[path] && !PHASE1_METHODS[path].includes(method)) continue;
      const row = { method: method.toUpperCase(), path, targetPath };
      if (!targetPath) {
        Object.assign(row, { status: "missing", problems: ["path not in target"] });
      } else {
        Object.assign(row, checkOperation(lookup, method, pathItem, op, targetPath, targetPaths[targetPath]));
      }
      operations.push(row);
    }
  }

  const missing = operations.filter((o) => o.status === "missing");
  const mismatched = operations.filter((o) => o.status === "mismatch");
  return {
    prefix,
    phase1_only: phase1Only,
    checked: operations.length,
    conformant: operations.length - missing.length - mismatched.length,
    ok: !missing.length && !mismatched.length,
    operations,
    missing: missing.map(({ method, path }) => ({ method, path })),
    mismatched: mismatched.map(({ method, path, problems }) => ({ method, path, problems })),
    contract_paths: Object.keys(contract.paths ?? {}).sort(),
    phase1_paths: PHASE1_PATHS,
  };
}

export function renderReport(report, { contractLabel, targetLabel }) {
  const lines = [];
  const scope = report.phase1_only ? " [phase1-only]" : "";
  const remap = report.prefix ? ` (prefix ${report.prefix})` : "";
  lines.push(`skein-ready — ${contractLabel} vs ${targetLabel}${scope}${remap}`);
  lines.push("");
  for (const op of report.operations) {
    const mark = op.status === "ok" ? "✓" : "✗";
    const head = `${mark} ${op.method.padEnd(6)} ${op.path}`;
    if (op.status === "ok") {
      lines.push(head);
    } else {
      lines.push(`${head} — ${op.status === "missing" ? "missing" : "mismatched"}`);
      for (const problem of op.problems) lines.push(`    - ${problem}`);
    }
  }
  lines.push("");
  lines.push(`${report.conformant}/${report.checked} operations conformant.`);
  if (report.missing.length) {
    lines.push(`missing (${report.missing.length}): ${report.missing.map((m) => `${m.method} ${m.path}`).join(", ")}`);
  }
  if (report.mismatched.length) {
    lines.push(`mismatched (${report.mismatched.length}): ${report.mismatched.map((m) => `${m.method} ${m.path}`).join(", ")}`);
  }
  lines.push(`conformance: ${report.ok ? "PASS" : "FAIL"}`);
  return lines.join("\n");
}
