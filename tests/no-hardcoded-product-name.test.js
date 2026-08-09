import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { agenticConfig } from "../agentic.config.ts";

// PW-1 guard, twin of no-hardcoded-hosts.test.js — an adopter renames the
// product and its agent trees in ONE place (agentic.config.ts `product`), so
// no component may spell either out. src/lib/product.ts is the only reader.
//
// Comments are exempt (they cite specs and phase docs by name) and so are the
// MSW fixtures under src/test/, which mirror the BACKEND's wording, not the
// UI's. Lowercase "cupel" is exempt too: localStorage keys and DOM ids are
// stable identifiers, not chrome.

const PRODUCT_LABEL = agenticConfig.product.label;
const TREE_TERM = /agent trees?/i;
const EXEMPT = ["src/test", "src/lib/product.ts"];

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path, out);
    else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(path);
  }
  return out;
}

/** Whole-line and block comments out; enough for this codebase's comment style. */
function stripComments(text) {
  return text
    .replace(/\{?\/\*[\s\S]*?\*\/\}?/g, "")
    .split("\n")
    .filter((line) => !/^\s*(\/\/|\*)/.test(line))
    .join("\n");
}

const sources = () =>
  walk("src")
    .filter((file) => !EXEMPT.some((prefix) => file.replace(/\\/g, "/").startsWith(prefix)))
    .map((file) => ({ file, code: stripComments(readFileSync(file, "utf8")) }));

describe("no hardcoded product name outside agentic.config.ts", () => {
  it(`no component under src/ spells "${PRODUCT_LABEL}" out`, () => {
    expect(sources().filter(({ code }) => code.includes(PRODUCT_LABEL)).map(({ file }) => file)).toEqual([]);
  });

  it("no component under src/ spells the agent-trees label out", () => {
    expect(sources().filter(({ code }) => TREE_TERM.test(code)).map(({ file }) => file)).toEqual([]);
  });

  it("sanity: the config and the helper's fallback DO carry both", () => {
    expect(readFileSync("agentic.config.ts", "utf8")).toContain(`label: "${PRODUCT_LABEL}"`);
    expect(readFileSync("src/lib/product.ts", "utf8")).toMatch(TREE_TERM);
  });
});
