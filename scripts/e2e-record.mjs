// P2-RECORD — `npm run e2e:record`: film the 13 journey specs.
//
// Same two-pass matrix as scripts/e2e-full.mjs (AUTH_MODE is the mock's boot
// env, so one Playwright run cannot host both modes) — but only the journeys,
// under playwright.config.ts's `record` project (video on, trace on, slowMo).
//
// Why blob shards + merge-reports: the HTML report is the review gallery, and
// two passes writing it directly would leave the second overwriting the first.
// Each pass writes a blob shard instead; `merge-reports` folds them into ONE
// report with all 13 films embedded. Both commands are stock Playwright — the
// gallery is not something we built (that is P4-REELS).
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const BLOB = path.join(ROOT, "blob-report");
// Outside blob-report: the blob reporter wipes that directory when a run starts.
const SHARDS = path.join(os.tmpdir(), "skein-e2e-shards");
const REPORT = path.join(ROOT, "playwright-report");

// Only jNN-*.spec.ts: the smoke/DoD/mobile walks are regression nets, not
// journeys, and nobody wants to watch them.
const JOURNEYS = "j\\d+-.*\\.spec\\.ts";

function run(pass, label, args, env) {
  console.log(`\n=== record: ${label} ===`);
  const started = Date.now();
  const result = spawnSync("npx", ["playwright", "test", "--project=record", ...args], {
    stdio: "inherit",
    shell: true,
    cwd: ROOT,
    env: { ...process.env, SKEIN_E2E_RECORD: "1", ...env },
  });
  // Both passes are the same project, so both write the same shard filename,
  // and the blob reporter clears its output dir at the start of a run — stash
  // each shard somewhere the next pass will not touch.
  mkdirSync(SHARDS, { recursive: true });
  for (const name of readdirSync(BLOB).filter((f) => f.endsWith(".zip"))) {
    renameSync(path.join(BLOB, name), path.join(SHARDS, `${pass}-${name}`));
  }
  console.log(`=== record: ${label} finished in ${((Date.now() - started) / 1000).toFixed(1)}s ===`);
  return result.status ?? 1;
}

rmSync(BLOB, { recursive: true, force: true });
rmSync(SHARDS, { recursive: true, force: true });

const off = run("off", "AUTH_MODE=off (journeys 1-9, 13)", [JOURNEYS, "--grep-invert", "@auth-on"], {});
const on = run("on", "AUTH_MODE=on (journeys 10-12)", [JOURNEYS, "--grep", "@auth-on"], {
  AUTH_E2E: "1",
});

const merge = spawnSync("npx", ["playwright", "merge-reports", "--reporter", "html", SHARDS], {
  stdio: "inherit",
  shell: true,
  cwd: ROOT,
  env: { ...process.env, PLAYWRIGHT_HTML_OPEN: "never" },
});

function films(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith(".webm"))
    .map((e) => statSync(path.join(e.parentPath ?? e.path, e.name)).size);
}

const sizes = films(REPORT);
const mb = (sizes.reduce((a, b) => a + b, 0) / 1e6).toFixed(1);
console.log(`
─────────────────────────────────────────────────────────
  ${sizes.length} films (${mb} MB) — playwright-report/data/*.webm

  Watch them:   npx playwright show-report

  The report is the gallery: one row per journey, each with
  its video, its screenshot and its step-by-step trace.
  Videos are EVIDENCE — the assertions decide pass/fail.
─────────────────────────────────────────────────────────`);

process.exit(off || on || (merge.status ?? 1));
