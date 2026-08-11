import { mkdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { defineConfig } from "@playwright/test";

// Smoke e2e (`npm run e2e:smoke`) against the
// REAL mock (no MSW): webServer boots BOTH processes, mock first.
//
// Scratch DB: CUPEL_MOCK_DB (mock/config.py:51) points the mock at a temp
// sqlite so e2e runs never touch mock/cupel-mock.sqlite dev data. The scratch
// dir is wiped at config load, so every run starts from a fresh bootstrap
// seed (mock/seed.py) and the file never accumulates.
// The wipe must run ONCE, in the runner process only: workers re-import this
// config while the mock already holds the sqlite open (EPERM on Windows), so
// an env flag — inherited by worker child processes — gates the side effect.
const scratchDir = path.join(os.tmpdir(), "cupel-e2e");
if (!process.env.CUPEL_E2E_SCRATCH_READY) {
  rmSync(scratchDir, { recursive: true, force: true });
  mkdirSync(scratchDir, { recursive: true });
  process.env.CUPEL_E2E_SCRATCH_READY = "1";
}

// Filming: `npm run e2e:record` (scripts/e2e-record.mjs) sets this. It picks
// the `record` project AND swaps the reporter: two passes write blob shards
// that merge into ONE built-in HTML report, which is the review gallery. The
// normal suites never see it.
const RECORDING = process.env.CUPEL_E2E_RECORD === "1";

export default defineConfig({
  testDir: "e2e",
  // Seeds the deterministic generator dataset (seed 42), loaded once the
  // mock is up. Skipped in AUTH_MODE=on runs; see e2e/global-setup.ts.
  globalSetup: "./e2e/global-setup.ts",
  // One worker: every spec shares the one mock instance + scratch DB.
  workers: 1,
  fullyParallel: false,
  timeout: 180_000,
  expect: { timeout: 15_000 },
  reporter: RECORDING ? [["list"], ["blob"]] : [["list"]],
  use: {
    baseURL: "http://localhost:5173",
    trace: "retain-on-failure",
  },
  projects: [
    // The normal suites. Every npm script pins --project=chromium so adding a
    // second project below cannot silently double their work.
    { name: "chromium", use: { browserName: "chromium" } },
    {
      // The film rig. Same browser, same specs; only the capture
      // settings and the pace differ.
      name: "record",
      use: {
        browserName: "chromium",
        // Keep every film, passing or not — a green run is the point.
        video: "on",
        // `on` (not retain-on-failure) so the HTML report doubles as a
        // step-by-step trace viewer next to each video.
        trace: "on",
        screenshot: "on",
        // 300ms per browser operation. Below ~150 the clicks read as jump
        // cuts; much above this a 9-step journey outlasts anyone's patience.
        // The step captions get their own dwell (e2e/helpers/hud.ts).
        launchOptions: { slowMo: 300 },
      },
      // slowMo taxes every action and every assertion retry, so the record
      // project gets its own budget rather than inflating the normal one.
      timeout: 600_000,
      expect: { timeout: 30_000 },
    },
  ],
  webServer: [
    {
      command: "python -m uvicorn mock.main:app --port 4010",
      url: "http://localhost:4010/healthz",
      reuseExistingServer: false,
      timeout: 60_000,
      env: {
        CUPEL_MOCK_DB: path.join(scratchDir, "mock.sqlite"),
        // Faster than dev defaults (mock/config.py:17-18) but slow enough
        // that the smoke test can observe tokens streaming before `done`.
        //
        // Filmed runs drive the mock ~3x slower: under slowMo + video +
        // trace the browser lags, and a reply that materialises in one frame
        // is a bad film.
        //
        // It USED to carry a second, load-bearing reason — a replay that
        // finished server-side before the run page mounted skipped the
        // auto-judge, which journey 5 films. That was a product bug, fixed in
        // the UX phase (auto-judge now keys off "done + judge configured + not
        // already judged", RunDetailPage.tsx); the slowdown is film pacing
        // only now, and removing it can no longer break journey 5.
        MOCK_TOKEN_DELAY: RECORDING ? "0.03" : "0.01",
        MOCK_STEP_DELAY: RECORDING ? "0.09" : "0.03",
        // Failure injection (mock/config.py fail_marker): the FIRST
        // attempt at any batch child whose payload mentions this string fails,
        // the retry succeeds. Inert unless a spec deliberately puts the marker
        // in a prompt — only e2e/j06-queue.spec.ts does.
        MOCK_FAIL_MARKER: "CUPEL-E2E-INJECTED-FAILURE",
        // `npm run e2e:auth` (scripts/e2e-auth.mjs) sets AUTH_E2E=1,
        // which boots THIS mock with AUTH_MODE=on and runs e2e/auth.spec.ts
        // only; auth.spec skips itself otherwise, so the plain e2e:smoke run
        // (and the deployed demo) stay off-mode and unchanged.
        ...(process.env.AUTH_E2E === "1" ? { AUTH_MODE: "on" } : {}),
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
