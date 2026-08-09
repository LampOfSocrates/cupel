import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

// Guard — "All API calls go through one configurable client
// ({base} prefix) — no hardcoded hosts anywhere" (feature-spec.md:158).
// The mock's host may appear ONLY in agentic.config.ts (the one config
// artifact, repo root); everything under src/ — code, tests, MSW fixtures —
// must resolve it through the target store.

const MOCK_HOST = "localhost:4010";

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path, out);
    else if (/\.(ts|tsx)$/.test(name)) out.push(path);
  }
  return out;
}

describe("no hardcoded hosts outside agentic.config.ts", () => {
  it(`no file under src/ contains "${MOCK_HOST}"`, () => {
    const offenders = walk("src").filter((file) =>
      readFileSync(file, "utf8").includes(MOCK_HOST),
    );
    expect(offenders).toEqual([]);
  });

  it("the config itself does declare the mock host (sanity: the grep works)", () => {
    expect(readFileSync("agentic.config.ts", "utf8")).toContain(MOCK_HOST);
  });
});
