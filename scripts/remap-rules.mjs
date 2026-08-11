// Path-remap rules — the shared primitive behind the browser create-app
// mapper's "path differences" step (docs/TASKS.md item 40). A plain prefix
// (cupel-ready.mjs detectPrefix, "everything lives under /nabu-service/…")
// covers only ONE real adopter shape. Three more showed up as soon as a real
// adopter was described:
//   - the tree id sits directly under the prefix, with no literal
//     "agenttrees" segment ("/nabu-service/agent1/chat", not
//     "/nabu-service/agenttrees/agent1/chat") — `dropAgenttrees`
//   - a resource is named differently ("conversations" -> "sessions") —
//     `renames`
//   - chat streams on its OWN route instead of Cupel's one endpoint + a
//     `stream` body flag ("/agent1/chat" for JSON, "/agent1/stream" for SSE)
//     — `splitStream`, which is why src/api/client.ts buildUrl grew a second
//     argument carrying `{ stream }`
//
// One function expresses all four, and it is used in three places that must
// never drift apart: LIVE, as the request-time `remap` written into
// agentic.config.ts (buildRemapFn / renderRemapSource, same algorithm,
// see remap-rules.test.js for the equivalence check); and at GENERATION
// TIME, to transform the CONTRACT's own path templates before comparing them
// against the adopter's spec (remapContract) — segment renames don't care
// whether "{tree}" is a live id or a template placeholder, so the same
// transform works on both without a second implementation.

import { compare } from "./conformance.mjs";
import { deriveBaseUrl, deriveIdentity, detectAuth } from "./cupel-ready.mjs";

/** @typedef {{prefix?: string, dropAgenttrees?: boolean, renames?: {from: string, to?: string}[], splitStream?: boolean, streamSuffix?: string}} RemapRules */

const defaults = (rules) => ({
  prefix: "",
  dropAgenttrees: false,
  renames: [],
  splitStream: false,
  streamSuffix: "stream",
  ...rules,
});

/** Whether these rules would change anything — an all-default set needs no remap at all. */
export function rulesAreEmpty(rules) {
  const r = defaults(rules);
  return !r.prefix && !r.dropAgenttrees && r.renames.filter((n) => n.from).length === 0 && !r.splitStream;
}

const renameTable = (renames) =>
  Object.fromEntries(renames.filter((r) => r.from).map((r) => [r.from, r.to ?? ""]));

function renameSegments(path, renames) {
  const table = renameTable(renames);
  if (!Object.keys(table).length) return path;
  return path
    .split("/")
    .map((segment) => (segment in table ? table[segment] : segment))
    .join("/");
}

const stripPrefix = (prefix) => prefix.replace(/^\/+|\/+$/g, "");

/**
 * The transform itself — usable both on a real request path (live, with
 * `opts.stream`) and on a contract path TEMPLATE ("/agenttrees/{tree}/chat"),
 * since `{tree}` is just an opaque segment neither dropAgenttrees nor
 * renames ever touch.
 */
export function buildRemapFn(rules) {
  const { prefix, dropAgenttrees, renames, splitStream, streamSuffix } = defaults(rules);
  const prefixPath = prefix ? `/${stripPrefix(prefix)}` : "";
  return (path, opts = {}) => {
    let out = dropAgenttrees ? path.replace(/^\/agenttrees(\/|$)/, "/") : path;
    out = renameSegments(out, renames);
    if (splitStream && opts?.stream && out.endsWith("/chat")) {
      out = out.replace(/\/chat$/, `/${streamSuffix}`);
    }
    return prefixPath + out;
  };
}

/**
 * The SAME transform, as arrow-function SOURCE TEXT for writing into
 * agentic.config.ts. Mirrors buildRemapFn segment-for-segment (a lookup
 * table, not per-rename regexes) so the two never diverge — see
 * remap-rules.test.js.
 */
export function renderRemapSource(rules) {
  const { prefix, dropAgenttrees, renames, splitStream, streamSuffix } = defaults(rules);
  const prefixPath = prefix ? `/${stripPrefix(prefix)}` : "";
  const table = renameTable(renames);
  if (!dropAgenttrees && !Object.keys(table).length && !splitStream) {
    return `(path) => ${JSON.stringify(prefixPath)} + path`;
  }
  const lines = ["(path, opts) => {", "  let out = path;"];
  if (dropAgenttrees) lines.push('  out = out.replace(/^\\/agenttrees(\\/|$)/, "/");');
  if (Object.keys(table).length) {
    lines.push(`  const RENAMES = ${JSON.stringify(table)};`);
    lines.push('  out = out.split("/").map((seg) => (seg in RENAMES ? RENAMES[seg] : seg)).join("/");');
  }
  if (splitStream) {
    lines.push(
      `  if (opts?.stream && out.endsWith("/chat")) out = out.replace(/\\/chat$/, ${JSON.stringify(`/${streamSuffix}`)});`,
    );
  }
  lines.push(`  return ${JSON.stringify(prefixPath)} + out;`);
  lines.push("}");
  return lines.join("\n");
}

/** `renderRemapSource`, wrapped as the full `  remap: (…) => {…},` field text
 * (2-space object-literal indent) — ready to splice into a target block. */
export function renderRemapField(rules) {
  const [first, ...rest] = renderRemapSource(rules).split("\n");
  return [`  remap: ${first}`, ...rest.map((line) => `  ${line}`)].join("\n") + ",";
}

/** contract, with every path key run through the same transform a real
 * request would get (default opts — the non-streaming shape; `splitStream`
 * does not change which family/operation exists, only which route it hits). */
export function remapContract(contract, rules) {
  if (rulesAreEmpty(rules)) return contract;
  const fn = buildRemapFn(rules);
  const paths = {};
  for (const [path, item] of Object.entries(contract.paths ?? {})) paths[fn(path)] = item;
  return { ...contract, paths };
}

/**
 * buildInit()'s shape (scripts/cupel-ready.mjs), but for a RULES-based remap
 * instead of prefix auto-detection: the contract is pre-transformed by the
 * same rules a real request goes through, so the conformance numbers here are
 * what the adopter actually gets once the rules are written into
 * agentic.config.ts — not a guess `cupel-ready --prefix` alone can't express.
 */
export function buildInitFromRules(contract, target, { source, rules, id = null, label = null }) {
  const remapped = remapContract(contract, rules);
  const base = deriveBaseUrl(target, source);
  const report = compare(remapped, target, {});
  const init = {
    source,
    ...deriveIdentity(base.baseUrl, { id, label }),
    ...base,
    ...detectAuth(target),
    remapRules: rules,
    remapPrefix: null,
    remapNote: null,
    conformance: { withoutRemap: null, withRemap: { conformant: report.conformant, checked: report.checked } },
  };
  return { init, effective: report };
}
