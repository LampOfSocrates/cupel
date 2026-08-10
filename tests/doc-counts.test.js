import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import path from "node:path";
import { facts } from "../scripts/contract-facts.mjs";

// Counts in prose rot. "The contract's N operations" has been wrong twice —
// 69 → 66 → 67 — in three documents at a time, because each sentence carried
// its own copy. The number is derived (scripts/contract-facts.mjs); this fails
// the build when a LIVING document disagrees with it.
//
// Historical documents are a different thing: a dated spike or review recorded
// what was true when it was written, and rewriting its arithmetic to today's
// number would make it a lie about its own date. Those are exempt BY NAME
// below, each with the reason, and each carries a header saying which contract
// version its counts belong to.

const DATED = {
  "TASKS.md": "a dated log — each item records what was true when it shipped",
  "docs/open-items.md": "a dated log of findings, quoting the counts as found",
  "docs/spike-agui.md": "research spike, 2026-08-07; its whole §5a analysis is built on the count of the day",
  "docs/review-2026-08-05.md": "a dated review of a specific commit",
  "docs/plan-agentic-app-maker.md": "superseded plan, kept as the record of what was superseded",
};

function livingDocs() {
  const files = [];
  for (const name of readdirSync(".")) {
    if (/\.(md|html)$/.test(name)) files.push(name);
  }
  for (const dir of ["docs", "scripts"]) {
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir)) {
      if (/\.(md|html|mjs)$/.test(name)) files.push(path.posix.join(dir, name));
    }
  }
  return files.filter((file) => !DATED[file]);
}

// A TOTAL claim, as opposed to a subset ("422 on 38 operations", "~9
// operations"): the phrasings prose actually uses for the whole contract, plus
// any conformance fraction, whose denominator is always the total.
const TOTAL_PATTERNS = [
  { what: "operations", re: /(?:of|contract's|contract is|carries|all)\s+(\d+)\s+operations/gi },
  { what: "operations", re: /(\d+)\s+operations\s+(?:across|in total|grouped)/gi },
  { what: "families", re: /(\d+)\s+families/gi },
];
// Bare fractions like "37/66" — a denominator this size in these documents is
// a conformance denominator, and that is the whole contract.
const FRACTION = /\b(\d+)\/(\d+)\b/g;
const FRACTION_FLOOR = 40;

function claims(text) {
  const found = [];
  for (const { what, re } of TOTAL_PATTERNS) {
    for (const match of text.matchAll(re)) {
      found.push({ what, value: Number(match[1]), quote: match[0] });
    }
  }
  for (const match of text.matchAll(FRACTION)) {
    const [numerator, denominator] = [Number(match[1]), Number(match[2])];
    if (denominator >= FRACTION_FLOOR && numerator <= denominator) {
      found.push({ what: "operations", value: denominator, quote: match[0] });
    }
  }
  return found;
}

const derived = facts();

describe("counts in prose", () => {
  const offenders = [];
  for (const file of livingDocs()) {
    for (const claim of claims(readFileSync(file, "utf8"))) {
      if (claim.value !== derived[claim.what]) {
        offenders.push(
          `${file}: "${claim.quote}" — the contract has ${derived[claim.what]} ${claim.what}`,
        );
      }
    }
  }

  it("state what the contract actually has (npm run facts)", () => {
    expect(offenders).toEqual([]);
  });

  // A guard nobody's prose can trip is a guard that is not running.
  it("would catch a stale number", () => {
    expect(claims("the contract's 66 operations")).toEqual([
      { what: "operations", value: 66, quote: "contract's 66 operations" },
    ]);
    expect(claims("reaches 37/66 with the remap")).toContainEqual({
      what: "operations",
      value: 66,
      quote: "37/66",
    });
    expect(claims("14 families")).toEqual([
      { what: "families", value: 14, quote: "14 families" },
    ]);
  });

  // Subsets are not totals: "38 of 67 answer 422" is a fact about 38 of them.
  it("leaves subset counts alone", () => {
    expect(claims("422 on 38 operations")).toEqual([]);
    expect(claims("~9 operations, of which AG-UI supplies 1")).toEqual([]);
    expect(claims("26 operations short")).toEqual([]);
  });

  it("exempts the dated documents by name, with the reason written down", () => {
    for (const [file, reason] of Object.entries(DATED)) {
      expect(existsSync(file), `${file} is exempted but does not exist`).toBe(true);
      expect(reason.length).toBeGreaterThan(20);
    }
  });
});

describe("the derived facts", () => {
  it("count every operation of every path, and the families are the tags", () => {
    expect(derived.operations).toBeGreaterThan(derived.paths);
    expect(derived.families).toBeGreaterThan(0);
    expect(derived.version).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
