// cupel-ready comparator engine (cupel-phases.md:74).
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

// There is no per-METHOD Phase-1 exemption any more. v0.3.0 had exactly one —
// the versioned PUT that Phase 2 added onto the Phase-1 path
// /eval/cases/{caseId} — and item 7 stage F4 moved every versioned save onto
// its own POST …/versions path, so the phase split is once again a split
// between PATHS. Filtering is path-level below; if a Phase-2 method is ever
// added to a Phase-1 path again, that is when a per-method map earns its
// place back.

const HTTP_METHODS = ["get", "put", "post", "delete", "options", "head", "patch", "trace"];

// ------------------------------------------------------------------ families
// The contract's families are its top-level `tags`, and an operation's family
// is its single tag — see the comment above `tags:` in openapi.yaml for why
// the declaration lives there and nowhere else. Nothing in this file or in
// cupel-ready.mjs carries a family list of its own; if it did, the two would
// drift the first time a family was added.
//
// A target/fixture spec that declares no tags simply has no families, and
// every family-aware output below degrades to nothing rather than inventing a
// classification. UNCLASSIFIED is what an operation with no tag reports as;
// the contract has none (tests/openapi-contract.test.js enforces exactly one
// tag per operation), but an adopter's spec may.
export const UNCLASSIFIED = "(unclassified)";

/** Declared family names, in document order. */
export function families(contract) {
  return (contract.tags ?? []).map((t) => t.name);
}

/** family name -> description, for a report that explains itself. */
export function familyDescriptions(contract) {
  return Object.fromEntries((contract.tags ?? []).map((t) => [t.name, t.description ?? null]));
}

/** The family of one operation: its single tag. */
export function operationFamily(op) {
  return op?.tags?.length ? op.tags[0] : UNCLASSIFIED;
}

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
      const row = { method: method.toUpperCase(), path, targetPath, family: operationFamily(op) };
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
    families: familyReport(contract, operations),
  };
}

/**
 * Per-family rollup of a compare() run, in the contract's declared order.
 * Families the run checked nothing for (--phase1-only skips most of them) are
 * omitted — reporting `0/0 none` for a family nobody asked about would read as
 * a gap. The `status` values are Health.capabilities' vocabulary on purpose:
 * this is the same question a backend answers about itself, asked of a spec.
 */
export function familyReport(contract, operations) {
  const order = [...families(contract), UNCLASSIFIED];
  const byFamily = new Map();
  for (const op of operations) {
    const row = byFamily.get(op.family) ?? { operations: 0, conformant: 0, missing: [], mismatched: [] };
    row.operations++;
    if (op.status === "ok") row.conformant++;
    else if (op.status === "missing") row.missing.push(`${op.method} ${op.path}`);
    else row.mismatched.push(`${op.method} ${op.path}`);
    byFamily.set(op.family, row);
  }
  const seen = new Set(byFamily.keys());
  const names = [...order.filter((n) => seen.has(n)), ...[...seen].filter((n) => !order.includes(n))];
  return names.map((name) => {
    const row = byFamily.get(name);
    return {
      name,
      status: row.conformant === row.operations ? "full" : row.conformant === 0 ? "none" : "partial",
      ...row,
    };
  });
}

export function renderReport(report, { contractLabel, targetLabel }) {
  const lines = [];
  const scope = report.phase1_only ? " [phase1-only]" : "";
  const remap = report.prefix ? ` (prefix ${report.prefix})` : "";
  lines.push(`cupel-ready — ${contractLabel} vs ${targetLabel}${scope}${remap}`);
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
  // By family, because that is the axis an adopter answers on: the generator's
  // --family <name>=mine|mock|hide takes one answer per line printed here.
  if (report.families?.length) {
    lines.push("by family:");
    for (const family of report.families) {
      const mark = { full: "✓", partial: "~", none: "✗" }[family.status];
      lines.push(`  ${mark} ${family.name.padEnd(15)} ${family.conformant}/${family.operations} ${family.status}`);
    }
    lines.push("");
  }
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
