#!/usr/bin/env node
// cupel-ready — backend readiness/conformance report.
// Run `npx cupel-ready <your-openapi>` and get a report of
// every missing endpoint or mismatched shape; e.g. "npx cupel-ready
// http://localhost:4010/openapi.json → conformance: PASS".
//
// Usage: cupel-ready <target> [options]
//   <target>              URL or local path of the backend's OpenAPI (JSON or YAML)
//   --contract <path>     contract to validate against (default ./openapi.yaml)
//   --prefix <p>          remap: prepend p to contract paths before lookup,
//                         e.g. --prefix /nabu-service
//   --header k:v          extra header for fetching a URL target (repeatable),
//                         e.g. --header "X-Demo-Token: secret" for gated demos
//   --insecure            skip TLS certificate verification when fetching a
//                         URL target (curl -k equivalent) — for a self-signed
//                         or incomplete-chain cert on a target you trust
//                         (staging, internal). Node's fetch is stricter about
//                         chains than curl, so "curl works, this doesn't" is
//                         almost always exactly this; try it before assuming
//                         a real network problem. Process-wide for the run,
//                         since this script makes exactly one fetch.
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
// The report is grouped BY FAMILY as well as by operation (`families` in
// --json), because family is the axis an adopter answers on — one
// full/partial/none line here per `--family <name>=mine|mock|hide` question
// the project generator will ask. The family names come from the contract's
// own `tags` (scripts/conformance.mjs families()); this script holds no list
// of its own, so adding a family to openapi.yaml is the whole change.
//
// Comparator depth and limits: scripts/conformance.mjs + docs/readiness.md.

import { readFileSync } from "node:fs";
import process from "node:process";
import { pathToFileURL } from "node:url";
import YAML from "yaml";
import SwaggerParser from "@apidevtools/swagger-parser";
import { compare, renderReport } from "./conformance.mjs";
import { extractAgentShape, foldTreeIds, remapContract } from "./remap-rules.mjs";

const USAGE =
  "usage: cupel-ready <openapi-url-or-file> [--contract openapi.yaml] " +
  "[--prefix /p] [--header k:v]... [--insecure] [--phase1-only] [--json] " +
  '[--init [--id myid] [--label "My API"]]';

export function parseArgs(argv) {
  const options = { contract: "openapi.yaml", prefix: "", headers: {}, insecure: false, json: false, phase1Only: false, init: false, id: null, label: null, target: null };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--contract") options.contract = argv[++i];
    else if (arg === "--prefix") options.prefix = argv[++i] ?? "";
    else if (arg === "--header") {
      const raw = argv[++i] ?? "";
      const colon = raw.indexOf(":");
      if (colon < 1) throw new Error(`--header expects "Name: value", got "${raw}"`);
      options.headers[raw.slice(0, colon).trim()] = raw.slice(colon + 1).trim();
    } else if (arg === "--insecure") options.insecure = true;
    else if (arg === "--json") options.json = true;
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

// Node's fetch (undici) wraps every network failure in a generic
// TypeError("fetch failed") and puts the actual reason on `.cause` — a bad
// cert, a refused connection, DNS failure, whatever. Printing only
// error.message (the old behavior) meant every one of those looked
// identical and undiagnosable. `.cause` can itself chain (rare, but
// AggregateError-wrapped causes do), so walk it rather than reading one level.
export function describeError(error) {
  const parts = [error.message];
  let cause = error.cause;
  while (cause) {
    parts.push(cause.message ?? String(cause));
    cause = cause.cause;
  }
  return parts.join("\n  caused by: ");
}

export async function loadTarget(source, headers, { insecure = false } = {}) {
  let text;
  if (/^https?:\/\//.test(source)) {
    // Process-wide and only for this one call the script ever makes — see
    // the --insecure usage comment above for why this is curl -k's
    // equivalent rather than a security regression in general use.
    const restoreTls = insecure ? disableTlsVerification() : null;
    try {
      const res = await fetch(source, { headers });
      if (!res.ok) throw new Error(`GET ${source} → ${res.status} ${res.statusText}`);
      text = await res.text();
    } finally {
      restoreTls?.();
    }
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

/** Returns a restore function so --insecure never leaks past this one fetch. */
function disableTlsVerification() {
  const previous = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
  console.error(
    "cupel-ready: --insecure set — TLS certificate verification is OFF for this request. " +
      "Only use this against a target you trust (self-signed/incomplete-chain staging, not an " +
      "arbitrary internet host).",
  );
  return () => {
    if (previous === undefined) delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
    else process.env.NODE_TLS_REJECT_UNAUTHORIZED = previous;
  };
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
 * `header` lets a caller that DOES write the config (scripts/init.mjs)
 * replace the paste-it-yourself preamble while reusing the same derivations
 * and the same rendering — there is only ever one target-block renderer.
 */
/**
 * `remapLines`, when given, REPLACES the remap comment+field this function
 * would otherwise derive from `init.remapPrefix` — the escape hatch for a
 * remap richer than one prefix string (scripts/remap-rules.mjs's `renames` /
 * `dropAgenttrees` / `splitStream`). `init.remapPrefix` stays the
 * only source of truth for every existing caller (init.mjs, this script's
 * own --init, create-app.mjs's plain-prefix path).
 */
export function renderInitBlock(init, { header = null, remapLines = null } = {}) {
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
  if (remapLines) {
    lines.push(...remapLines);
  } else {
    const without = init.conformance.withoutRemap;
    if (init.remapPrefix) {
      const withRemap = init.conformance.withRemap;
      lines.push(`  // conformance without remap ${without.conformant}/${without.checked} -> with ${init.remapPrefix} remap ${withRemap.conformant}/${withRemap.checked}`);
      lines.push(`  remap: (p) => ${JSON.stringify(init.remapPrefix)} + p,`);
    } else {
      lines.push(`  // conformance ${without.conformant}/${without.checked} without remap (no path-prefix remap detected)`);
      if (init.remapNote) lines.push(`  // ${init.remapNote}`);
    }
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
    console.error(`cupel-ready: ${describeError(error)}\n${USAGE}`);
    return 2;
  }
  if (options.help) {
    console.log(USAGE);
    return 0;
  }

  let contract, target;
  let folded = null;
  try {
    contract = await SwaggerParser.dereference(options.contract);
    target = await loadTarget(options.target, options.headers, { insecure: options.insecure });

    // A spec that ENUMERATES its agents (`/svc/agent1/chat`, `/svc/agent2/chat`)
    // has no `{tree}` template for the comparator to match, so without this
    // every tree-scoped operation reports missing and a backend implementing
    // the lot scores 0/67 — the single most misleading answer this tool can
    // give. Two halves are needed: collapse the ids onto one template (and
    // declare the path param the enumeration stood in for), AND put the
    // contract into the same shape, since folding alone still leaves
    // `/agenttrees/{tree}/chat` looking for a path their spec spells
    // `/svc/{tree}/chat`. An explicit --prefix means the human has already
    // said how their routes map, so it wins and none of this runs.
    if (!options.prefix) {
      const shape = extractAgentShape(target, contract);
      if (shape?.treeIds?.length) {
        target = foldTreeIds(target, shape);
        contract = remapContract(contract, shape.rules);
        folded = shape;
      }
    }
  } catch (error) {
    console.error(`cupel-ready: ${describeError(error)}`);
    if (error.message === "fetch failed" && !options.insecure) {
      console.error(
        "  (a bare \"fetch failed\" with a TLS-shaped cause above is usually a cert chain " +
          "curl tolerates and Node doesn't — try again with --insecure if you trust this target)",
      );
    }
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
    if (folded) {
      payload.folded_agents = { prefix: folded.prefix, ids: folded.treeIds, param: folded.treeParam };
    }
    if (initMode) payload.init = { ...initMode.init, block: renderInitBlock(initMode.init) };
    console.log(JSON.stringify(payload, null, 2));
  } else {
    if (folded) {
      console.log(
        `note: your spec lists ${folded.treeIds.length} agents under ` +
          `${folded.prefix || "/"} (${folded.treeIds.slice(0, 4).join(", ")}` +
          `${folded.treeIds.length > 4 ? ", …" : ""}); comparing them as one ` +
          `{${folded.treeParam}} so the counts below are per-operation, not per-agent.\n`,
      );
    }
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
