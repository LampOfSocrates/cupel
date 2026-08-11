import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import YAML from "yaml";
import { operationCounts } from "../scripts/create-app-server.mjs";

// The browser mapper's transport layer (item 40) — pure helpers only. The
// HTTP server itself is exercised by hand (docs/TASKS.md item 40 write-up);
// what's unit-testable without booting a socket lives here.

describe("operationCounts", () => {
  it("counts operations per family, straight off the real contract", () => {
    const contract = {
      paths: {
        "/a": { get: { tags: ["chat"] }, post: { tags: ["chat"] } },
        "/b": { get: { tags: ["conversations"] } },
      },
    };
    expect(operationCounts(contract)).toEqual({ chat: 2, conversations: 1 });
  });

  it("skips operations with no tag rather than inventing a family", () => {
    const contract = { paths: { "/a": { get: {} } } };
    expect(operationCounts(contract)).toEqual({});
  });

  it("adds up to the real contract's operation count", () => {
    const contract = YAML.parse(readFileSync("openapi.yaml", "utf8"));
    const total = Object.values(operationCounts(contract)).reduce((a, b) => a + b, 0);
    const methods = ["get", "put", "post", "delete", "patch"];
    let expected = 0;
    for (const item of Object.values(contract.paths)) {
      for (const m of methods) if (item[m]) expected++;
    }
    expect(total).toBe(expected);
  });
});

describe("the mapper page ships as a static file", () => {
  it("exists next to create-app-server.mjs", () => {
    expect(existsSync("scripts/create-app-ui/index.html")).toBe(true);
  });

  it("is self-contained — no external script or stylesheet fetches", () => {
    const html = readFileSync("scripts/create-app-ui/index.html", "utf8");
    expect(html).not.toMatch(/<script[^>]+src=/i);
    expect(html).not.toMatch(/<link[^>]+href="https?:/i);
  });
});
