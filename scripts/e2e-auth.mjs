// P2-T07 / P2-E2E — `npm run e2e:auth`: the AUTH_MODE=on half of the suite.
// A tiny Node wrapper because npm scripts can't set env vars portably on
// Windows (cmd) + POSIX without a cross-env dependency.
//
// AUTH_E2E=1 does three things (documented in playwright.config.ts):
// the mock webServer gains AUTH_MODE=on, the deterministic generator seed is
// skipped (it writes with no token and would 401), and the @auth-on specs
// un-skip themselves.
import { spawnSync } from "node:child_process";

const result = spawnSync("npx", ["playwright", "test", "--grep", "@auth-on"], {
  stdio: "inherit",
  shell: true,
  env: { ...process.env, AUTH_E2E: "1" },
});
process.exit(result.status ?? 1);
