#!/usr/bin/env node
// cupel-ready — backend readiness/conformance report.
// cupel-phases.md:74: "run npx cupel-ready <your-openapi> and get a report of
// every missing endpoint or mismatched shape"; :107 "npx cupel-ready
// http://localhost:4010/openapi.json → conformance: PASS".
//
// Usage: cupel-ready <target> [options]
//   <target>              URL or local path of the backend's OpenAPI (JSON or YAML)
//   --contract <path>     contract to validate against (default ./openapi.yaml)
//   --prefix <p>          remap: prepend p to contract paths before lookup,
//                         e.g. --prefix /nabu-service (cupel-phases.md:75)
//   --header k:v          extra header for fetching a URL target (repeatable),
//                         e.g. --header "X-Demo-Token: secret" for gated demos
//   --phase1-only         restrict checks to the Phase-1 surface (see
//                         PHASE1_PATHS in scripts/conformance.mjs)
//   --json                machine-readable report on stdout
//   --init                emit a ready-to-paste agentic.config.ts target block
//                         (auto-detected baseUrl / prefix remap / auth) after
//                         the conformance report. TEXT ONLY — never writes
//                         agentic.config.ts (docs/readiness.md).
//                         With --prefix, that prefix is used instead of
//                         auto-detection. With --json the block + derivations
//                         land under an `init` key.
//   --id / --label        identity for the --init block (default: derived
//                         from the target hostname)
// Exit codes: 0 fully conformant for the checked set · 1 gaps found · 2 error.
// (--init bases the exit code on the with-remap run — what you'd get after
// pasting the block.)
//
// Comparator depth and limits: scripts/conformance.mjs + docs/readiness.md.

import { readFileSync } from "node:fs";
import process from "node:process";
import { pathToFileURL } from "node:url";
import YAML from "yaml";
import SwaggerParser from "@apidevtools/swagger-parser";
import { compare, renderReport } from "./conformance.mjs";

const USAGE =
  "usage: cupel-ready <openapi-url-or-file> [--contract openapi.yaml] " +
  "[--prefix /p] [--header k:v]... [--phase1-only] [--json] " +
  '[--init [--id myid] [--label "My API"]]';

export function parseArgs(argv) {
  const options = { contract: "openapi.yaml", prefix: "", headers: {}, json: false, phase1Only: false, init: false, id: null, label: null, target: null };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--contract") options.contract = argv[++i];
    else if (arg === "--prefix") options.prefix = argv[++i] ?? "";
    else if (arg === "--header") {
      const raw = argv[++i] ?? "";
      const colon = raw.indexOf(":");
      if (colon < 1) throw new Error(`--header expects "Name: value", got "${raw}"`);
      options.headers[raw.slice(0, colon).trim()] = raw.slice(colon + 1).trim();
    } else if (arg === "--json") options.json = true;
    else if (arg === "--phase1-only") options.phase1Only = true;
    else if (arg === "--init") options.init = true;
    else if (arg === "--id") options.id = argv[++i];
    else if (arg === "--label") options.label = argv[++i];
    else if (arg === "--help" || arg === "-h") options.help = true;
    else if (arg.startsWith("--")) throw new Error(`unknown option ${arg}`);
    else if (options.target) throw new Error(`unexpected argument ${arg}`);
    else options.target = arg;
  }
  if (!options.help && !options.target) throw new Error("missing <target>");
  if (!options.init && (options.id || options.label)) throw new Error("--id/--label require --init");
  return options;
}

export async function loadTarget(source, headers) {
  let text;
  if (/^https?:\/\//.test(source)) {
    const res = await fetch(source, { headers });
    if (!res.ok) throw new Error(`GET ${source} → ${res.status} ${res.statusText}`);
    text = await res.text();
  } else {
    text = readFileSync(source, "utf8");
  }
  // YAML is a JSON superset, so one parser covers both target formats.
  const doc = YAML.parse(text);
  if (!doc || typeof doc !== "object" || !doc.paths) {
    throw new Error(`${source} does not look like an OpenAPI document (no paths)`);
  }
  return SwaggerParser.dereference(doc);
}

// ---------------------------------------------------------------- --init mode
// Derive a ready-to-paste agentic.config.ts target block from the
// target's own OpenAPI. TEXT ONLY — this script never writes agentic.config.ts;
// the one config artifact stays human-owned and the human pastes the block.

/**
 * baseUrl precedence (documented in docs/readiness.md):
 *   1. servers[0].url when it is ABSOLUTE (http/https);
 *   2. else, when the target was fetched from a URL, that URL's origin
 *      (i.e. the /openapi.json-ish path stripped);
 *   3. else "" + a TODO comment (local file, no absolute server declared).
 */
export function deriveBaseUrl(target, source) {
  const server = target.servers?.[0]?.url;
  if (typeof server === "string" && /^https?:\/\//.test(server)) {
    return { baseUrl: server.replace(/\/+$/, ""), baseUrlSource: "servers" };
  }
  if (/^https?:\/\//.test(source)) {
    return { baseUrl: new URL(source).origin, baseUrlSource: "fetched-origin" };
  }
  return { baseUrl: "", baseUrlSource: "unknown" };
}

const matchedPaths = (report) => report.operations.filter((op) => op.targetPath).length;

/**
 * Prefix remap auto-detection: candidates are the target's own leading path
 * segments (up to 3 deep, param segments excluded) — e.g. target paths like
 * /nabu-service/agenttrees/... yield candidate /nabu-service. Each candidate
 * is scored by re-running the comparator's matching with the prefix applied
 * and counting resolved contract paths; the single candidate that strictly
 * beats the no-prefix run wins. Tied winners → no remap + a note.
 */
export function detectPrefix(contract, target, { phase1Only = false } = {}) {
  const base = compare(contract, target, { phase1Only });
  const candidates = new Set();
  for (const path of Object.keys(target.paths ?? {})) {
    const segments = path.split("/").filter(Boolean);
    for (let depth = 1; depth < segments.length && depth <= 3; depth++) {
      const candidate = "/" + segments.slice(0, depth).join("/");
      if (!candidate.includes("{")) candidates.add(candidate);
    }
  }
  const runs = [...candidates].map((prefix) => {
    const report = compare(contract, target, { prefix, phase1Only });
    return { prefix, report, matched: matchedPaths(report) };
  });
  const best = Math.max(0, ...runs.map((r) => r.matched));
  const winners = runs.filter((r) => r.matched === best && best > matchedPaths(base));
  if (winners.length === 1) {
    return { prefix: winners[0].prefix, base, withRemap: winners[0].report, note: null };
  }
  if (winners.length > 1) {
    const list = winners.map((w) => w.prefix).sort().join(", ");
    return {
      prefix: null, base, withRemap: null,
      note: `ambiguous prefix candidates (${list}) tie at ${best} matched paths -- set remap manually`,
    };
  }
  return { prefix: null, base, withRemap: null, note: null };
}

/** Token-ish securitySchemes → requiresToken (the switcher's token UI). */
const TOKENISH_TYPES = new Set(["http", "apiKey", "oauth2", "openIdConnect"]);

export function detectAuth(target) {
  const authSchemes = Object.entries(target.components?.securitySchemes ?? {})
    .filter(([, s]) => s && TOKENISH_TYPES.has(s.type))
    .map(([name, s]) => ({ name, type: s.type, scheme: s.scheme ?? null }));
  return { requiresToken: authSchemes.length > 0, authSchemes };
}

/** id/label from flags, else derived from the baseUrl hostname. */
export function deriveIdentity(baseUrl, { id = null, label = null } = {}) {
  let host = "";
  try {
    host = baseUrl ? new URL(baseUrl).hostname : "";
  } catch {
    // non-URL baseUrl: fall through to the generic identity
  }
  const derived = host ? host.split(".")[0].toLowerCase().replace(/[^a-z0-9]+/g, "-") : "backend";
  return { id: id ?? derived, label: label ?? (host || derived) };
}

export function buildInit(contract, target, { source, id = null, label = null, prefix = "", phase1Only = false }) {
  const detection = prefix
    ? {
        // --prefix overrides auto-detection: the human already knows the remap.
        prefix,
        base: compare(contract, target, { phase1Only }),
        withRemap: compare(contract, target, { prefix, phase1Only }),
        note: null,
      }
    : detectPrefix(contract, target, { phase1Only });
  const effective = detection.withRemap ?? detection.base;
  const counts = ({ conformant, checked }) => ({ conformant, checked });
  const base = deriveBaseUrl(target, source);
  const init = {
    source,
    ...deriveIdentity(base.baseUrl, { id, label }),
    ...base,
    ...detectAuth(target),
    remapPrefix: detection.prefix,
    remapNote: detection.note,
    conformance: {
      withoutRemap: counts(detection.base),
      withRemap: detection.withRemap ? counts(detection.withRemap) : null,
    },
  };
  return { init, effective };
}

/**
 * `header` lets a caller that DOES write the config (scripts/init.mjs, PW-1)
 * replace the paste-it-yourself preamble while reusing the same derivations
 * and the same rendering — there is only ever one target-block renderer.
 */
export function renderInitBlock(init, { header = null } = {}) {
  const baseComment = init.baseUrlComment ?? {
    servers: "from servers[0].url",
    "fetched-origin": "from the fetched URL's origin (spec declares no absolute servers[0].url)",
    unknown: "TODO: local file and no absolute servers[0].url -- fill in your backend origin",
  }[init.baseUrlSource];
  const lines = [
    ...(header ?? [
      `// Generated by cupel-ready --init from ${init.source}. TEXT ONLY:`,
      "// cupel-ready never writes agentic.config.ts -- paste this block into its",
      "// `targets` array yourself (the one config artifact stays human-owned).",
    ]),
    "{",
    `  id: ${JSON.stringify(init.id)},`,
    `  label: ${JSON.stringify(init.label)},`,
    `  baseUrl: ${JSON.stringify(init.baseUrl)}, // ${baseComment}`,
  ];
  const without = init.conformance.withoutRemap;
  if (init.remapPrefix) {
    const withRemap = init.conformance.withRemap;
    lines.push(`  // conformance without remap ${without.conformant}/${without.checked} -> with ${init.remapPrefix} remap ${withRemap.conformant}/${withRemap.checked}`);
    lines.push(`  remap: (p) => ${JSON.stringify(init.remapPrefix)} + p,`);
  } else {
    lines.push(`  // conformance ${without.conformant}/${without.checked} without remap (no path-prefix remap detected)`);
    if (init.remapNote) lines.push(`  // ${init.remapNote}`);
  }
  if (init.requiresToken) {
    const named = init.authSchemes
      .map((s) => `"${s.name}" (${s.type}${s.scheme ? ` ${s.scheme}` : ""})`)
      .join(", ");
    lines.push(`  requiresToken: true, // securityScheme ${named}`);
  }
  lines.push(`  banner: { label: ${JSON.stringify(`${init.label.toUpperCase()} BACKEND`)} }, // non-prod default; use \`banner: false\` for prod`);
  lines.push("},");
  return lines.join("\n");
}

export async function main(argv = process.argv.slice(2)) {
  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    console.error(`cupel-ready: ${error.message}\n${USAGE}`);
    return 2;
  }
  if (options.help) {
    console.log(USAGE);
    return 0;
  }

  let contract, target;
  try {
    contract = await SwaggerParser.dereference(options.contract);
    target = await loadTarget(options.target, options.headers);
  } catch (error) {
    console.error(`cupel-ready: ${error.message}`);
    return 2;
  }

  // --init: the reported run is the with-remap one (what pasting the block
  // gets you); the block itself carries the before/after conformant counts.
  const initMode = options.init
    ? buildInit(contract, target, {
        source: options.target,
        id: options.id,
        label: options.label,
        prefix: options.prefix,
        phase1Only: options.phase1Only,
      })
    : null;
  const report = initMode
    ? initMode.effective
    : compare(contract, target, { prefix: options.prefix, phase1Only: options.phase1Only });
  const meta = {
    contract: { source: options.contract, version: contract.info?.version ?? null },
    target: { source: options.target, version: target.info?.version ?? null },
  };

  if (options.json) {
    const payload = { ...meta, ...report };
    if (initMode) payload.init = { ...initMode.init, block: renderInitBlock(initMode.init) };
    console.log(JSON.stringify(payload, null, 2));
  } else {
    console.log(renderReport(report, {
      contractLabel: `${options.contract} v${meta.contract.version ?? "?"} (${report.contract_paths.length} paths)`,
      targetLabel: options.target,
    }));
    if (initMode) console.log("\n" + renderInitBlock(initMode.init));
  }
  return report.ok ? 0 : 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  process.exitCode = await main();
}
