import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

// The Render image builds the bundle from a hand-listed COPY set (Dockerfile
// stage 1), so a new root-level file that src/ imports must be added there or
// `vite build` dies with UNRESOLVED_IMPORT inside the image — invisible
// locally, fatal on deploy (that is exactly what happened to
// agentic.config.ts).

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

// The runtime stage grew a second moving part (the litestream
// binary) and a new CMD. Same failure shape as the agentic.config.ts incident:
// invisible locally, only fatal in the image.
describe("Dockerfile runtime stage (P2-PERSIST storage modes)", () => {
  const dockerfile = readFileSync("Dockerfile", "utf8");

  it("boots via mock.boot, which is what picks the storage mode", () => {
    expect(dockerfile).toMatch(/^CMD \["python", "-m", "mock\.boot"\]$/m);
  });

  it("ships a pinned litestream binary so CUPEL_STORAGE=s3 is a pure env flip", () => {
    expect(dockerfile).toMatch(/^FROM litestream\/litestream:\d+\.\d+\.\d+ AS litestream$/m);
    expect(dockerfile).toMatch(
      /^COPY --from=litestream \/usr\/local\/bin\/litestream \/usr\/local\/bin\/litestream$/m,
    );
  });

  it("copies the whole mock package, so new modules need no Dockerfile edit", () => {
    expect(dockerfile).toMatch(/^COPY mock \.\/mock$/m);
  });

  // Same failure shape again (2026-08-10): mock/root.py serves docs/index.html
  // at "/" and mounts docs/assets/ at /assets, both read from disk relative to
  // the mock package — invisible locally (docs/ already exists in a checkout),
  // 404/plain-text-fallback in the image until the runtime stage COPYs them.
  it("copies docs/index.html and docs/assets, which mock/root.py serves", () => {
    expect(dockerfile).toMatch(/^COPY docs\/index\.html \.\/docs\/index\.html$/m);
    expect(dockerfile).toMatch(/^COPY docs\/assets \.\/docs\/assets$/m);
  });

  // 2026-08-10 build_failed, live: the COPY above has nothing to read once
  // .dockerignore excludes the whole docs/ folder from the build CONTEXT
  // (a different thing from the final image, but Docker still needs the
  // source to exist to satisfy a COPY). A bare "docs/" line here would
  // silently break the COPY again.
  it(".dockerignore does not blanket-exclude docs/ (the COPY above needs it in the build context)", () => {
    const ignore = readFileSync(".dockerignore", "utf8");
    expect(ignore).not.toMatch(/^docs\/?$/m);
  });

  it("keeps the database out of the code tree and out of the build context", () => {
    expect(dockerfile).toMatch(/^ENV CUPEL_MOCK_DB=/m);
    // `*.sqlite` alone matches root level only — a nested dev database copied
    // into the image would make `litestream restore -if-db-not-exists` skip
    // the restore and boot the demo on stale data.
    expect(readFileSync(".dockerignore", "utf8")).toMatch(/^\*\*\/\*\.sqlite$/m);
  });
});
