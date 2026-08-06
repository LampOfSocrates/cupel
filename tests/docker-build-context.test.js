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

// P2-PERSIST — the runtime stage grew a second moving part (the litestream
// binary) and a new CMD. Same failure shape as the agentic.config.ts incident:
// invisible locally, only fatal in the image.
describe("Dockerfile runtime stage (P2-PERSIST storage modes)", () => {
  const dockerfile = readFileSync("Dockerfile", "utf8");

  it("boots via mock.boot, which is what picks the storage mode", () => {
    expect(dockerfile).toMatch(/^CMD \["python", "-m", "mock\.boot"\]$/m);
  });

  it("ships a pinned litestream binary so SKEIN_STORAGE=s3 is a pure env flip", () => {
    expect(dockerfile).toMatch(/^FROM litestream\/litestream:\d+\.\d+\.\d+ AS litestream$/m);
    expect(dockerfile).toMatch(
      /^COPY --from=litestream \/usr\/local\/bin\/litestream \/usr\/local\/bin\/litestream$/m,
    );
  });

  it("copies the whole mock package, so new modules need no Dockerfile edit", () => {
    expect(dockerfile).toMatch(/^COPY mock \.\/mock$/m);
  });

  it("keeps the database out of the code tree and out of the build context", () => {
    expect(dockerfile).toMatch(/^ENV SKEIN_MOCK_DB=/m);
    // `*.sqlite` alone matches root level only — a nested dev database copied
    // into the image would make `litestream restore -if-db-not-exists` skip
    // the restore and boot the demo on stale data.
    expect(readFileSync(".dockerignore", "utf8")).toMatch(/^\*\*\/\*\.sqlite$/m);
  });
});
