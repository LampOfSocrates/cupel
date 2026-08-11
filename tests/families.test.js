import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import {
  OUTPUT_FILE,
  loadContract,
  pathPattern,
  render,
  routes,
} from "../scripts/gen-families.mjs";

// The family table is derived from openapi.yaml and checked in. Two things
// have to stay true: the checked-in file matches the contract (drift), and
// the matching rules it encodes actually resolve the paths the client builds.

const contract = loadContract();

describe("src/api/families.generated.ts", () => {
  it("matches the contract (regenerate with `npm run gen:families`)", () => {
    expect(readFileSync(OUTPUT_FILE, "utf8")).toBe(render(contract));
  });

  it("covers every contract path", () => {
    const covered = new Set(routes(contract).map((r) => r.template));
    const missing = Object.keys(contract.paths).filter((p) => !covered.has(p));
    expect(missing).toEqual([]);
  });

  it("names only families the contract declares", () => {
    const declared = new Set(contract.tags.map((t) => t.name));
    const used = new Set(routes(contract).map((r) => r.family));
    expect([...used].filter((f) => !declared.has(f))).toEqual([]);
  });
});

describe("path matching", () => {
  const table = routes(contract).map((r) => ({ ...r, re: new RegExp(pathPattern(r.template)) }));
  const familyOf = (path) => table.find((r) => r.re.test(path))?.family ?? null;

  it.each([
    ["/me", "identity"],
    ["/agenttrees", "trees"],
    ["/agenttrees/agent1/chat", "chat"],
    ["/agenttrees/agent1/conversations", "conversations"],
    ["/agenttrees/agent1/conversations/c_42/turns", "conversations"],
    ["/agenttrees/agent1/turns/t_7/trace", "trace"],
    ["/tasks/stream", "tasks"],
    ["/eval/cases", "datasets"],
    ["/eval/judgments", "judging"],
    ["/agenttrees/agent1/evaluations", "replay"],
    ["/admin/users", "admin"],
    ["/healthz", "meta"],
  ])("%s -> %s", (path, family) => {
    expect(familyOf(path)).toBe(family);
  });

  // The ordering rule, stated as a test because getting it wrong is silent:
  // /eval/cases/import would otherwise resolve as a case id.
  it("a literal segment beats a parameter one", () => {
    const literal = table.findIndex((r) => r.template === "/eval/cases/import");
    const templated = table.findIndex((r) => r.template === "/eval/cases/{caseId}");
    expect(literal).toBeGreaterThanOrEqual(0);
    expect(templated).toBeGreaterThan(literal);
  });

  it("an unknown path resolves to no family", () => {
    expect(familyOf("/not/a/contract/path")).toBeNull();
  });
});
