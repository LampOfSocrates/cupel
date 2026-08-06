// P2-DEVSTART — `npm start`: ONE command that boots the studio UI and, when
// agentic.config.ts's `localMock.enabled` is true, the bundled demo backend
// (the FastAPI mock) next to it. Plain Node ESM, no new dependencies — child
// processes are spawned the way scripts/e2e-auth.mjs does it.
//
// User intent this implements (2026-08-06): "when this app is deployed on
// render then that mock backend is the whole thing ... when someone checks out
// and connects to their backend that backend will hold its own persistence.
// There should be a flag which says also run the demo backend. Since that demo
// backend will only ever run on the developer's machine it should just use
// filesystem and a local sqlite. This should be clearly visible in the startup
// config and when starting the app. Is there a single command to start ui as
// well as mock backend."
//
// HOW THIS READS THE TS CONFIG (deliberate choice, no bundler added):
// Node >= 22.18 / 24 strips TypeScript types natively, so this script just
// `import()`s agentic.config.ts — the real module, no second parser to drift
// from it and no generated JSON to keep in sync. agentic.config.ts contains
// only erasable syntax (interfaces + a typed const), which is exactly what
// type stripping supports. On an older Node the import throws and we say so,
// pointing at the two-terminal fallback (`npm run dev` + `npm run mock`),
// which keeps working regardless.
//
// The UI port is vite's (vite.config.ts:7). It is NOT in agentic.config.ts —
// that file configures backends — so it lives here as one constant, and vite
// is started with --strictPort so a taken port fails loudly instead of
// drifting to 5174 and making this banner a lie.

import { spawn } from "node:child_process";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const UI_PORT = 5173;

// P2-PERSIST — the demo backend's storage mode. `local` (the default, and the
// only thing a developer checkout ever wants) is a plain SQLite file; `s3`
// replicates that same file to an S3-compatible bucket with Litestream, which
// is what the hosted demo runs. The mode is an ENV choice, not a config-file
// choice: it is a property of the machine you are on, not of the product, and
// the deploy sets it. Mirrors mock/storage.py — keep the names in step.
const S3_ENV = [
  "SKEIN_S3_BUCKET",
  "SKEIN_S3_ENDPOINT",
  "SKEIN_S3_ACCESS_KEY_ID",
  "SKEIN_S3_SECRET_ACCESS_KEY",
];
const DEFAULT_S3_PATH = "skein-mock"; // mock/storage.py DEFAULT_S3_PATH

/**
 * Pure planner — what `npm start` will run and print, derived from the one
 * config artifact plus the storage env. Split out from the spawning so it is
 * testable without booting anything (tests/dev-start.test.js).
 *
 * @param {object} config the agentic.config.ts object
 * @param {Record<string,string|undefined>} env process env (SKEIN_STORAGE, SKEIN_S3_*)
 * @returns {{commands: {name: string, command: string, args: string[], env: Record<string,string>}[], bannerLines: string[]}}
 */
export function buildStartupPlan(config, env = {}) {
  const label = config?.product?.label ?? "Skein";
  const localMock = config?.localMock;
  const enabled = Boolean(localMock?.enabled);
  const s3 = String(env.SKEIN_STORAGE ?? "").trim().toLowerCase() === "s3";

  const ui = {
    name: "ui",
    command: "npm",
    args: ["run", "dev", "--", "--strictPort"],
    env: {},
  };

  const commands = [];
  const bannerLines = [label, `  UI       http://localhost:${UI_PORT}`];

  if (enabled) {
    // Backend first: it is the slower boot, and vite needs nothing from it.
    // s3 mode needs the storage wrapper (restore from the bucket, then
    // litestream replicate -exec uvicorn), so it boots mock.boot instead of
    // uvicorn directly and passes the port the way a container would.
    commands.push({
      name: "mock",
      command: "python",
      args: s3
        ? ["-m", "mock.boot"]
        : ["-m", "uvicorn", "mock.main:app", "--port", String(localMock.port)],
      env: s3
        ? { SKEIN_MOCK_DB: localMock.dbPath, PORT: String(localMock.port) }
        : { SKEIN_MOCK_DB: localMock.dbPath },
    });
    bannerLines.push(`  Backend  bundled demo mock · http://localhost:${localMock.port}`);
    if (s3) {
      const missing = S3_ENV.filter((key) => !env[key]);
      const replica = missing.length
        ? `NOT configured — set ${missing.join(", ")} (docs/deployment.md)`
        : `s3://${env.SKEIN_S3_BUCKET}/${env.SKEIN_S3_PATH || DEFAULT_S3_PATH}`;
      bannerLines.push(
        `           storage: s3 · ${localMock.dbPath} → Litestream replica ${replica}`,
        "           SINGLE WRITER — never point a second instance at that bucket",
      );
    } else {
      bannerLines.push(
        `           storage: local · ${localMock.dbPath} (local file, this machine only)`,
      );
    }
    bannerLines.push(
      "           agentic.config.ts localMock.enabled = true — set it to false",
      "           when you point Skein at your own backend",
    );
  } else {
    const wanted = config?.defaultTarget?.dev;
    const target = config?.targets?.find((t) => t.id === wanted);
    const where = target
      ? target.baseUrl || "same-origin (relative URLs)"
      : `no target "${wanted}" in agentic.config.ts — fix defaultTarget.dev`;
    bannerLines.push(
      `  Backend  your backend · ${where}`,
      "           Skein stores nothing locally — your backend holds all persistence",
      "           agentic.config.ts localMock.enabled = false — the bundled demo",
      "           backend is not running",
    );
  }

  commands.push(ui);
  return { commands, bannerLines };
}

/** Load the one config artifact. See the HOW THIS READS THE TS CONFIG note. */
export async function loadConfig() {
  const file = path.join(ROOT, "agentic.config.ts");
  try {
    const mod = await import(pathToFileURL(file).href);
    return mod.agenticConfig;
  } catch (err) {
    console.error(
      [
        `Could not read ${file}: ${err?.message ?? err}`,
        `Node ${process.versions.node} may predate native TypeScript type`,
        "stripping (needs Node >= 22.18). Upgrade Node, or start the two",
        "processes yourself: `npm run dev` and `npm run mock`.",
      ].join("\n"),
    );
    process.exit(1);
  }
}

// ------------------------------------------------------------------ runtime

const PREFIX_WIDTH = 6;

function prefixed(name, chunk, stream) {
  const text = String(chunk).replace(/\r\n/g, "\n").replace(/\n$/, "");
  if (!text) return;
  const tag = `[${name}]`.padEnd(PREFIX_WIDTH);
  for (const line of text.split("\n")) stream.write(`${tag} ${line}\n`);
}

/**
 * Windows has no process groups to signal, and `shell: true` means our direct
 * child is cmd.exe with the real server underneath it — so kill the whole
 * tree with taskkill /T. POSIX gets a plain SIGTERM (then SIGKILL on the
 * shutdown timeout).
 */
function killTree(child) {
  if (!child.pid || child.exitCode !== null || child.signalCode) return;
  if (process.platform === "win32") {
    spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
  } else {
    child.kill("SIGTERM");
  }
}

async function main() {
  const config = await loadConfig();
  const { commands, bannerLines } = buildStartupPlan(config, process.env);

  console.log("");
  for (const line of bannerLines) console.log(line);
  console.log("");

  const children = [];
  let shuttingDown = false;
  let exitCode = 0;

  const shutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    for (const { child } of children) killTree(child);
    // Nothing should outlive us: if a child ignores the kill, take the whole
    // launcher down anyway rather than hang the terminal.
    const timer = setTimeout(() => process.exit(exitCode), 5000);
    timer.unref();
  };

  for (const step of commands) {
    // npm is npm.cmd on Windows — spawn cannot exec it without a shell (same
    // reason scripts/e2e-auth.mjs uses shell: true). The argv is joined into
    // the command string rather than passed as an array because shell+array
    // is deprecated (DEP0190); every argument here is a fixed literal or a
    // number from the config, and paths travel via env, so there is nothing
    // to quote.
    const child = spawn([step.command, ...step.args].join(" "), {
      cwd: ROOT,
      shell: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, ...step.env },
    });
    children.push({ name: step.name, child });

    child.stdout.on("data", (c) => prefixed(step.name, c, process.stdout));
    child.stderr.on("data", (c) => prefixed(step.name, c, process.stderr));

    child.on("error", (err) => {
      console.error(`[${step.name}] failed to start: ${err.message}`);
      exitCode = 1;
      shutdown();
    });

    child.on("exit", (code, signal) => {
      if (!shuttingDown) {
        console.error(
          `[${step.name}] exited unexpectedly (${signal ?? `code ${code}`}) — stopping the rest`,
        );
        exitCode = code === 0 || code === null ? 1 : code;
        shutdown();
      }
      if (children.every(({ child: c }) => c.exitCode !== null || c.signalCode)) {
        process.exit(exitCode);
      }
    });
  }

  // Ctrl+C reaches the children too (shared console / process group); the
  // handler makes sure of it and keeps the exit clean either way.
  for (const sig of ["SIGINT", "SIGTERM", "SIGBREAK"]) {
    process.on(sig, shutdown);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
