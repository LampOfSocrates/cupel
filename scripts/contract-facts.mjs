#!/usr/bin/env node
// contract-facts — the countable facts about openapi.yaml, derived.
//
// "The contract's 67 operations" has been wrong twice (69 → 66 → 67), in three
// documents at a time, because every one of those sentences carried its own
// copy of the number. This is the source of truth for the ones prose is
// allowed to state, and tests/doc-counts.test.js fails the build when a living
// document disagrees with it — historical documents are dated and exempt, by
// name, in that test.
//
// Usage: npm run facts [--json]
//
// Deliberately NOT a template engine: the docs stay hand-written prose. The
// number is derived here, checked there, and typed by a human in between.

import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { loadContract } from "./gen-families.mjs";

const METHODS = new Set(["get", "put", "post", "delete", "patch", "head", "options"]);

/** @returns {{version: string, paths: number, operations: number, families: number}} */
export function contractFacts(contract) {
  const paths = Object.entries(contract.paths ?? {});
  return {
    version: contract.info?.version ?? "?",
    paths: paths.length,
    operations: paths.reduce(
      (total, [, item]) => total + Object.keys(item ?? {}).filter((m) => METHODS.has(m)).length,
      0,
    ),
    families: (contract.tags ?? []).length,
  };
}

export function facts(file) {
  return contractFacts(loadContract(file));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const derived = facts();
  if (process.argv.includes("--json")) {
    console.log(JSON.stringify(derived, null, 2));
  } else {
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
    console.log(
      [
        `openapi.yaml v${derived.version} (${path.relative(process.cwd(), path.join(root, "openapi.yaml"))})`,
        `  ${derived.operations} operations`,
        `  ${derived.paths} paths`,
        `  ${derived.families} families`,
        "",
        "These are the numbers prose may state. tests/doc-counts.test.js enforces it.",
      ].join("\n"),
    );
  }
}
