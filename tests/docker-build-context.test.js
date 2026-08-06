import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

// The Render image builds the bundle from a hand-listed COPY set (Dockerfile
// stage 1), so a new root-level file that src/ imports must be added there or
// `vite build` dies with UNRESOLVED_IMPORT inside the image — invisible
// locally, fatal on deploy (that is exactly what happened to
// agentic.config.ts between P2-CONFIG and P2-DEVSTART).

const ROOT_IMPORT = /from\s+"\.\.\/\.\.?\/([\w.-]+)"/g;

describe("Dockerfile build context covers the root files src/ imports", () => {
  it("copies agentic.config.ts into the frontend stage", () => {
    const dockerfile = readFileSync("Dockerfile", "utf8");
    expect(dockerfile).toMatch(/^COPY .*agentic\.config\.ts.*\.\/$/m);
  });

  it("the app really does import it from the repo root (sanity)", () => {
    const matches = [...readFileSync("src/api/target.ts", "utf8").matchAll(ROOT_IMPORT)];
    expect(matches.map((m) => m[1])).toContain("agentic.config");
  });
});
