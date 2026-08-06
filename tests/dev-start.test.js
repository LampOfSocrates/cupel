import { describe, it, expect } from "vitest";
import { buildStartupPlan, UI_PORT } from "../scripts/dev.mjs";
import { agenticConfig } from "../agentic.config.ts";

// P2-DEVSTART — `npm start` (scripts/dev.mjs) boots the UI plus, per the one
// config artifact's localMock flag, the bundled demo backend. The plan builder
// is pure so the commands and the startup banner can be asserted here without
// spawning anything.

const base = {
  product: { name: "skein", label: "Skein" },
  targets: [
    { id: "mock", label: "Mock", baseUrl: "http://localhost:4010" },
    { id: "local", label: "Local", baseUrl: "http://localhost:8000" },
    { id: "prod", label: "Prod", baseUrl: "" },
  ],
  defaultTarget: { dev: "mock", production: "prod" },
  localMock: { enabled: true, port: 4010, dbPath: "mock/skein-mock.sqlite" },
};

const enabled = (env = {}) => buildStartupPlan(base, env);
const disabled = (dev = "local", env = {}) =>
  buildStartupPlan(
    {
      ...base,
      defaultTarget: { ...base.defaultTarget, dev },
      localMock: { ...base.localMock, enabled: false },
    },
    env,
  );

// P2-PERSIST — SKEIN_STORAGE picks how durable the demo backend's SQLite file
// is; s3 replicates it to a bucket with Litestream (the hosted demo).
const S3_ENV = {
  SKEIN_STORAGE: "s3",
  SKEIN_S3_BUCKET: "skein-demo",
  SKEIN_S3_ENDPOINT: "https://acct.r2.cloudflarestorage.com",
  SKEIN_S3_ACCESS_KEY_ID: "AKIAEXAMPLE",
  SKEIN_S3_SECRET_ACCESS_KEY: "s3cr3t",
};

describe("buildStartupPlan — localMock enabled", () => {
  it("runs the mock (with SKEIN_MOCK_DB + port) and the UI", () => {
    const { commands } = enabled();
    expect(commands.map((c) => c.name)).toEqual(["mock", "ui"]);

    const mock = commands[0];
    expect(mock.command).toBe("python");
    expect(mock.args).toEqual(["-m", "uvicorn", "mock.main:app", "--port", "4010"]);
    expect(mock.env).toEqual({ SKEIN_MOCK_DB: "mock/skein-mock.sqlite" });

    const ui = commands[1];
    expect(ui.command).toBe("npm");
    // --strictPort: the banner promises :5173, so a port clash must fail loudly.
    expect(ui.args).toEqual(["run", "dev", "--", "--strictPort"]);
  });

  it("names the bundled demo backend and where its data lives", () => {
    const banner = enabled().bannerLines.join("\n");
    expect(enabled().bannerLines[0]).toBe("Skein");
    expect(banner).toContain(`UI       http://localhost:${UI_PORT}`);
    expect(banner).toContain("Backend  bundled demo mock · http://localhost:4010");
    expect(banner).toContain(
      "storage: local · mock/skein-mock.sqlite (local file, this machine only)",
    );
    expect(banner).toContain("localMock.enabled = true");
  });
});

describe("buildStartupPlan — storage mode (P2-PERSIST)", () => {
  it("defaults to local: plain uvicorn, plain SQLite file, no S3 anything", () => {
    for (const env of [{}, { SKEIN_STORAGE: "local" }, { SKEIN_STORAGE: "nonsense" }]) {
      const { commands, bannerLines } = enabled(env);
      expect(commands[0].args).toEqual([
        "-m", "uvicorn", "mock.main:app", "--port", "4010",
      ]);
      expect(commands[0].env).toEqual({ SKEIN_MOCK_DB: "mock/skein-mock.sqlite" });
      const banner = bannerLines.join("\n");
      expect(banner).toContain("storage: local · mock/skein-mock.sqlite");
      expect(banner).not.toContain("Litestream");
      expect(banner).not.toContain("s3://");
    }
  });

  it("s3 boots the storage wrapper and names the replica + the single-writer rule", () => {
    const { commands, bannerLines } = enabled(S3_ENV);
    // mock.boot restores from the bucket, then runs litestream replicate -exec.
    expect(commands[0].args).toEqual(["-m", "mock.boot"]);
    expect(commands[0].env).toEqual({
      SKEIN_MOCK_DB: "mock/skein-mock.sqlite",
      PORT: "4010",
    });
    const banner = bannerLines.join("\n");
    expect(banner).toContain(
      "storage: s3 · mock/skein-mock.sqlite → Litestream replica s3://skein-demo/skein-mock",
    );
    expect(banner).toContain("SINGLE WRITER");
    // secrets are never echoed to the terminal
    expect(banner).not.toContain("s3cr3t");
    expect(banner).not.toContain("AKIAEXAMPLE");
  });

  it("s3 honours SKEIN_S3_PATH", () => {
    expect(
      enabled({ ...S3_ENV, SKEIN_S3_PATH: "demo/db" }).bannerLines.join("\n"),
    ).toContain("s3://skein-demo/demo/db");
  });

  it("s3 with missing env says exactly which vars are unset", () => {
    const banner = enabled({ SKEIN_STORAGE: "s3", SKEIN_S3_BUCKET: "b" })
      .bannerLines.join("\n");
    expect(banner).toContain("NOT configured — set SKEIN_S3_ENDPOINT, SKEIN_S3_ACCESS_KEY_ID, SKEIN_S3_SECRET_ACCESS_KEY");
    expect(banner).toContain("docs/deployment.md");
  });

  it("storage mode is irrelevant when the bundled mock is off", () => {
    const banner = disabled("local", S3_ENV).bannerLines.join("\n");
    expect(banner).not.toContain("storage:");
    expect(banner).not.toContain("Litestream");
  });
});

describe("buildStartupPlan — localMock disabled (adopter with their own backend)", () => {
  it("starts the UI only", () => {
    const { commands } = disabled();
    expect(commands.map((c) => c.name)).toEqual(["ui"]);
  });

  it("names the default dev target's baseUrl as the backend", () => {
    const banner = disabled().bannerLines.join("\n");
    expect(banner).toContain("Backend  your backend · http://localhost:8000");
    expect(banner).toContain(
      "Skein stores nothing locally — your backend holds all persistence",
    );
    expect(banner).toContain("localMock.enabled = false");
  });

  it("claims no local storage — no sqlite path, no storage line", () => {
    const banner = disabled().bannerLines.join("\n");
    expect(banner).not.toContain("storage:");
    expect(banner).not.toContain("sqlite");
    expect(banner).not.toContain("this machine only");
    expect(banner).not.toContain("bundled demo mock ·");
  });

  it("same-origin targets read as such, and a bad defaultTarget.dev says so", () => {
    expect(disabled("prod").bannerLines.join("\n")).toContain(
      "Backend  your backend · same-origin (relative URLs)",
    );
    expect(disabled("nope").bannerLines.join("\n")).toContain(
      'no target "nope" in agentic.config.ts',
    );
  });
});

describe("the real agentic.config.ts", () => {
  it("declares a localMock block the launcher can plan from", () => {
    expect(agenticConfig.localMock).toEqual({
      enabled: true,
      port: 4010,
      dbPath: "mock/skein-mock.sqlite",
    });
  });

  it("keeps the mock target pointed at the port the launcher boots", () => {
    const { commands, bannerLines } = buildStartupPlan(agenticConfig);
    const mockTarget = agenticConfig.targets.find(
      (t) => t.id === agenticConfig.defaultTarget.dev,
    );
    expect(mockTarget.baseUrl).toBe(`http://localhost:${agenticConfig.localMock.port}`);
    expect(commands.map((c) => c.name)).toEqual(["mock", "ui"]);
    expect(bannerLines.join("\n")).toContain(mockTarget.baseUrl);
  });
});
