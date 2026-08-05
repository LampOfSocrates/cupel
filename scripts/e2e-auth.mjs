// P2-T07 — `npm run e2e:auth`: run the auth e2e with the mock in
// AUTH_MODE=on. A tiny Node wrapper because npm scripts can't set env vars
// portably on Windows (cmd) + POSIX without a cross-env dependency.
// AUTH_E2E=1 does two things (documented in playwright.config.ts):
// the mock webServer gains AUTH_MODE=on, and e2e/auth.spec.ts un-skips.
import { spawnSync } from "node:child_process";

const result = spawnSync("npx", ["playwright", "test", "e2e/auth.spec.ts"], {
  stdio: "inherit",
  shell: true,
  env: { ...process.env, AUTH_E2E: "1" },
});
process.exit(result.status ?? 1);
