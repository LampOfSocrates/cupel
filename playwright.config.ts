import { mkdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { defineConfig } from "@playwright/test";

// P1-TE2E — smoke e2e (skein-phases.md:46,55 "npm run e2e:smoke") against the
// REAL mock (no MSW): webServer boots BOTH processes, mock first.
//
// Scratch DB: SKEIN_MOCK_DB (mock/config.py:51) points the mock at a temp
// sqlite so e2e runs never touch mock/skein-mock.sqlite dev data. The scratch
// dir is wiped at config load, so every run starts from a fresh bootstrap
// seed (mock/seed.py) and the file never accumulates.
// The wipe must run ONCE, in the runner process only: workers re-import this
// config while the mock already holds the sqlite open (EPERM on Windows), so
// an env flag — inherited by worker child processes — gates the side effect.
const scratchDir = path.join(os.tmpdir(), "skein-e2e");
if (!process.env.SKEIN_E2E_SCRATCH_READY) {
  rmSync(scratchDir, { recursive: true, force: true });
  mkdirSync(scratchDir, { recursive: true });
  process.env.SKEIN_E2E_SCRATCH_READY = "1";
}

export default defineConfig({
  testDir: "e2e",
  // One worker: both specs share the one mock instance + scratch DB.
  workers: 1,
  fullyParallel: false,
  timeout: 180_000,
  expect: { timeout: 15_000 },
  reporter: [["list"]],
  use: {
    baseURL: "http://localhost:5173",
    trace: "retain-on-failure",
  },
  projects: [{ name: "chromium", use: { browserName: "chromium" } }],
  webServer: [
    {
      command: "python -m uvicorn mock.main:app --port 4010",
      url: "http://localhost:4010/healthz",
      reuseExistingServer: false,
      timeout: 60_000,
      env: {
        SKEIN_MOCK_DB: path.join(scratchDir, "mock.sqlite"),
        // Faster than dev defaults (mock/config.py:17-18) but slow enough
        // that the smoke test can observe tokens streaming before `done`.
        MOCK_TOKEN_DELAY: "0.01",
        MOCK_STEP_DELAY: "0.03",
      },
    },
    {
      // --strictPort: if 5173 is taken vite must fail loudly, not drift to
      // 5174 while Playwright waits on the configured baseURL forever.
      command: "npm run dev -- --strictPort",
      url: "http://localhost:5173",
      reuseExistingServer: false,
      timeout: 120_000,
    },
  ],
});
