#!/usr/bin/env node
// skein-ready — backend readiness/conformance report (P2-READY).
// skein-phases.md:74: "run npx skein-ready <your-openapi> and get a report of
// every missing endpoint or mismatched shape"; :107 "npx skein-ready
// http://localhost:4010/openapi.json → conformance: PASS".
//
// Usage: skein-ready <target> [options]
//   <target>              URL or local path of the backend's OpenAPI (JSON or YAML)
//   --contract <path>     contract to validate against (default ./openapi.yaml)
//   --prefix <p>          remap: prepend p to contract paths before lookup,
//                         e.g. --prefix /nabu-service (skein-phases.md:75)
//   --header k:v          extra header for fetching a URL target (repeatable),
//                         e.g. --header "X-Demo-Token: secret" for gated demos
//   --phase1-only         restrict checks to the Phase-1 surface (see
//                         PHASE1_PATHS in scripts/conformance.mjs)
//   --json                machine-readable report on stdout
// Exit codes: 0 fully conformant for the checked set · 1 gaps found · 2 error.
//
// Comparator depth and limits: scripts/conformance.mjs + docs/readiness.md.

import { readFileSync } from "node:fs";
import process from "node:process";
import { pathToFileURL } from "node:url";
import YAML from "yaml";
import SwaggerParser from "@apidevtools/swagger-parser";
import { compare, renderReport } from "./conformance.mjs";

const USAGE =
  "usage: skein-ready <openapi-url-or-file> [--contract openapi.yaml] " +
  "[--prefix /p] [--header k:v]... [--phase1-only] [--json]";

export function parseArgs(argv) {
  const options = { contract: "openapi.yaml", prefix: "", headers: {}, json: false, phase1Only: false, target: null };
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
    else if (arg === "--help" || arg === "-h") options.help = true;
    else if (arg.startsWith("--")) throw new Error(`unknown option ${arg}`);
    else if (options.target) throw new Error(`unexpected argument ${arg}`);
    else options.target = arg;
  }
  if (!options.help && !options.target) throw new Error("missing <target>");
  return options;
}

async function loadTarget(source, headers) {
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

export async function main(argv = process.argv.slice(2)) {
  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    console.error(`skein-ready: ${error.message}\n${USAGE}`);
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
    console.error(`skein-ready: ${error.message}`);
    return 2;
  }

  const report = compare(contract, target, {
    prefix: options.prefix,
    phase1Only: options.phase1Only,
  });
  const meta = {
    contract: { source: options.contract, version: contract.info?.version ?? null },
    target: { source: options.target, version: target.info?.version ?? null },
  };

  if (options.json) {
    console.log(JSON.stringify({ ...meta, ...report }, null, 2));
  } else {
    console.log(renderReport(report, {
      contractLabel: `${options.contract} v${meta.contract.version ?? "?"} (${report.contract_paths.length} paths)`,
      targetLabel: options.target,
    }));
  }
  return report.ok ? 0 : 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  process.exitCode = await main();
}
