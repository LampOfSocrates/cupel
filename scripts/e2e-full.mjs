// `npm run e2e`: the full Playwright suite that walks all 13 user journeys in
// both auth modes.
//
// TWO Playwright runs, not one: AUTH_MODE is the mock's boot env
// (mock/auth.py:65) and playwright.config.ts starts exactly one mock per run,
// so a single invocation cannot host both modes.
//
// THE MATRIX (and why):
//   pass 1 — AUTH_MODE=off, everything except @auth-on. That is journeys 1-9
//            and 13, plus the Phase-1 smoke/DoD walks and the portrait shell.
//            Off-mode is the demo's mode and the one adopters start in.
//   pass 2 — AUTH_MODE=on, ONLY @auth-on (journeys 10, 11, 12). Re-running the
//            auth-independent journeys under a token would roughly double the
//            wall clock to re-prove a property the architecture already
//            guarantees: no component branches on the auth mode (CLAUDE.md
//            invariant "no AUTH_MODE branches"), the token is attached in one
//            place (src/api/client.ts), and j12 walks a full chat with it
//            attached to cover that one seam.
import { spawnSync } from "node:child_process";

function run(label, args, env) {
  console.log(`\n=== e2e: ${label} ===`);
  const started = Date.now();
  // --project=chromium: there is a second `record` project, and
  // Playwright runs every project unless one is named.
  const result = spawnSync("npx", ["playwright", "test", "--project=chromium", ...args], {
    stdio: "inherit",
    shell: true,
    env: { ...process.env, ...env },
  });
  console.log(`=== e2e: ${label} finished in ${((Date.now() - started) / 1000).toFixed(1)}s ===`);
  return result.status ?? 1;
}

const off = run("AUTH_MODE=off (journeys 1-9, 13 + smoke)", ["--grep-invert", "@auth-on"], {});
const on = run("AUTH_MODE=on (journeys 10-12)", ["--grep", "@auth-on"], { AUTH_E2E: "1" });

process.exit(off || on);
