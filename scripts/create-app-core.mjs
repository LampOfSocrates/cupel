// create-app's actual logic — every decision function, plus the CLI-args
// parser and the non-interactive (`--yes`) runner. Deliberately separate from
// scripts/create-app.mjs (the CLI entry point, which re-exports everything
// here) and scripts/create-app-server.mjs (the browser mapper's HTTP
// transport, item 40): both of THOSE import FROM this module, and this
// module imports neither of them.
//
// That split exists for a real reason, not tidiness: create-app.mjs is the
// process entry point (top-level `await main()`), and it dynamically
// `import()`s create-app-server.mjs when no `--yes` flag is given. If
// create-app-server.mjs statically imported create-app.mjs back — which it
// used to, before this file existed — Node's ESM loader deadlocks: the entry
// module can't finish evaluating until its own dynamic import resolves, and
// that import can't resolve until the entry module finishes evaluating.
// Node detects this and exits with code 13 ("Detected unsettled top-level
// await") instead of ever printing the mapper's URL. Routing every shared
// function through a plain module neither the entry point nor the server
// depends on removes the cycle entirely.

import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { buildInit, loadTarget, renderInitBlock } from "./cupel-ready.mjs";
import { slugify, valueRange } from "./init.mjs";
import { renderReadme } from "./generated-readme.mjs";
import { buildInitFromRules, renderRemapField, rulesAreEmpty } from "./remap-rules.mjs";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const CONTRACT_FILE = path.join(ROOT, "openapi.yaml");
export const ANSWERS = ["mine", "mock", "hide"];

// --------------------------------------------------------------------- args

export const USAGE =
  "usage: npm run create -- [name] [--out dir] [--openapi url|file] " +
  "[--agent-endpoint url [--stream sse|json]] [--family name=mine|mock|hide]... " +
  "[--tree-term one[,many]] [--yes] [--force] [--json]";

export function parseArgs(argv) {
  const options = {
    name: null, out: null, openapi: null, agentEndpoint: null, stream: null,
    families: {}, treeTerm: null, yes: false, force: false, json: false, help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--out") options.out = argv[++i];
    else if (arg === "--openapi") options.openapi = argv[++i];
    else if (arg === "--agent-endpoint") options.agentEndpoint = argv[++i];
    else if (arg === "--stream") options.stream = argv[++i];
    else if (arg === "--tree-term") options.treeTerm = argv[++i];
    else if (arg === "--family") {
      const raw = argv[++i] ?? "";
      const eq = raw.indexOf("=");
      if (eq < 1) throw new Error(`--family expects "name=mine|mock|hide", got "${raw}"`);
      const name = raw.slice(0, eq).trim();
      const answer = raw.slice(eq + 1).trim();
      if (!ANSWERS.includes(answer)) {
        throw new Error(`--family ${name}: "${answer}" is not mine, mock or hide`);
      }
      options.families[name] = answer;
    } else if (arg === "--yes" || arg === "-y") options.yes = true;
    else if (arg === "--force") options.force = true;
    else if (arg === "--json") options.json = true;
    else if (arg === "--help" || arg === "-h") options.help = true;
    else if (arg.startsWith("--")) throw new Error(`unknown option ${arg}`);
    else if (options.name) throw new Error(`unexpected argument ${arg}`);
    else options.name = arg;
  }
  if (options.stream && !["sse", "json"].includes(options.stream)) {
    throw new Error(`--stream expects sse or json, got "${options.stream}"`);
  }
  if (options.stream && !options.agentEndpoint) {
    throw new Error("--stream describes --agent-endpoint, which was not given");
  }
  if (options.openapi && options.agentEndpoint) {
    throw new Error("--openapi and --agent-endpoint are two answers to the same question — pick one");
  }
  return options;
}

// ------------------------------------------------------------- tech check
// Stated BEFORE anything is generated, prerequisites included, so nobody
// discovers a dependency at first run (item 10b).

function commandVersion(command, args) {
  try {
    return execFileSync(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return null;
  }
}

/** First python on PATH that answers, with its version — `python3` then `python`. */
export function detectPython(probe = commandVersion) {
  for (const command of ["python3", "python"]) {
    const raw = probe(command, ["--version"]);
    const match = raw && /(\d+)\.(\d+)/.exec(raw);
    if (match) {
      return { command, version: raw.replace(/^Python\s+/i, ""), major: +match[1], minor: +match[2] };
    }
  }
  return null;
}

export function nodeOk(version = process.versions.node, minimum = "22.18") {
  const [major, minor] = version.split(".").map(Number);
  const [needMajor, needMinor] = minimum.split(".").map(Number);
  return major > needMajor || (major === needMajor && minor >= needMinor);
}

/**
 * The report printed before the questionnaire. `needsPython` is not known yet
 * at that point — the answers decide it — so Python is reported as a
 * CONDITIONAL prerequisite, which is exactly what it is.
 */
export function techReport({ node = process.versions.node, python = detectPython() } = {}) {
  const lines = [];
  const ok = nodeOk(node);
  lines.push(`  ${ok ? "ok  " : "MISS"} Node ${node} (this app needs >= 22.18)`);
  const pythonOk = Boolean(python) && (python.major > 3 || (python.major === 3 && python.minor >= 11));
  lines.push(
    python
      ? `  ${pythonOk ? "ok  " : "MISS"} Python ${python.version} via \`${python.command}\`` +
        (pythonOk ? "" : " — the bundled mock backend needs 3.11+")
      : "  MISS Python — not on PATH; the bundled mock backend needs 3.11+",
  );
  return { lines, nodeOk: ok, pythonOk, python };
}

// ------------------------------------------------------------ family answers

// A sort HINT, not a list: it decides the order questions are asked in, and
// anything it does not name is still asked (in contract order, after these).
// Chat first because that is the wedge persona's whole reason for being here;
// the four near-automatic ones last.
const ASK_ORDER = [
  "chat", "conversations", "agents", "evaluations", "eval", "trace", "tasks",
  "memory", "settings", "admin", "trees", "identity", "meta", "auth",
];

export function askOrder(names) {
  const known = ASK_ORDER.filter((name) => names.includes(name));
  return [...known, ...names.filter((name) => !known.includes(name))];
}

/**
 * The suggested answer per family, before the human is asked anything.
 *
 * With a backend to compare against, the suggestion IS the conformance
 * verdict: `full` -> mine, anything less -> mock, because a family the UI can
 * only half-reach is a screen that half-works, which is worse than an honest
 * mock. Persona B (a bare agent endpoint) gets `mine` for chat — the shim
 * covers that one family and nothing else. With neither, everything is `mock`:
 * that is persona A, the product demo, and it must stay one command with no
 * questions asked.
 *
 * @param {string[]} names every family of the contract
 * @param {object} context {report, agentEndpoint, flags}
 */
export function suggestAnswers(names, { report = null, agentEndpoint = null, flags = {} } = {}) {
  const byFamily = new Map((report?.families ?? []).map((f) => [f.name, f]));
  const out = {};
  for (const name of names) {
    if (flags[name]) {
      out[name] = { answer: flags[name], source: "flag" };
      continue;
    }
    if (flags.all) {
      out[name] = { answer: flags.all, source: "flag (all)" };
      continue;
    }
    if (agentEndpoint) {
      out[name] =
        name === "chat"
          ? { answer: "mine", source: "your agent endpoint" }
          : { answer: "mock", source: "no backend for it yet" };
      continue;
    }
    const family = byFamily.get(name);
    if (!family) {
      out[name] = { answer: "mock", source: report ? "not in your spec" : "no backend given" };
      continue;
    }
    out[name] =
      family.status === "full"
        ? { answer: "mine", source: `your backend has all ${family.operations}` }
        : {
            answer: "mock",
            source: `your backend has ${family.conformant}/${family.operations}`,
          };
  }
  return out;
}

// The families that carry a door of their own (src/lib/families.ts
// ROUTE_FAMILY). Hiding all of them generates an app whose every route is a
// redirect to another redirect, so the generator refuses instead.
const SCREEN_FAMILIES = ["chat", "evaluations", "eval", "agents", "tasks", "settings"];

/** Refuse a set of answers that would produce a UI with nothing in it. */
export function validateAnswers(answers) {
  if (Object.values(answers).every((answer) => answer === "hide")) {
    return "every family is hidden — that generates an app with no screens";
  }
  if (!SCREEN_FAMILIES.some((family) => answers[family] && answers[family] !== "hide")) {
    return `every screen-bearing family is hidden — leave at least one of ${SCREEN_FAMILIES.join(", ")}`;
  }
  return null;
}

// ------------------------------------------------------------------- copying
// What lands in the generated folder. The rule behind the list: everything
// needed to RUN and EDIT the app, nothing that only makes sense inside this
// repo. Cupel's own suites go too — they assert Cupel's family answers, so in
// a folder that hid a family they would fail on arrival and teach nobody
// anything. The README says so rather than leaving it to be discovered.
export const COPY_ENTRIES = [
  "index.html",
  "vite.config.ts",
  "eslint.config.js",
  "openapi.yaml",
  ".gitignore",
  "src",
  "mock",
  "scripts/dev.mjs",
  "scripts/cupel-ready.mjs",
  "scripts/conformance.mjs",
  "scripts/gen-families.mjs",
  "scripts/init.mjs",
];

const SKIP_PATTERNS = [
  /(^|[\\/])__pycache__([\\/]|$)/,
  /(^|[\\/])node_modules([\\/]|$)/,
  /\.test\.(ts|tsx|js|mjs)$/,
  /(^|[\\/])src[\\/]test([\\/]|$)/,
  /(^|[\\/])mock[\\/]tests([\\/]|$)/,
  /\.sqlite(-wal|-shm)?$/,
  /\.pyc$/,
];

/** Whether a path (relative to the repo root, either separator) is copied. */
export function isCopied(relativePath) {
  return !SKIP_PATTERNS.some((pattern) => pattern.test(relativePath));
}

function copyEntry(from, to, relative) {
  const source = path.join(from, relative);
  if (!existsSync(source)) return [];
  const written = [];
  if (statSync(source).isDirectory()) {
    for (const name of readdirSync(source)) {
      written.push(...copyEntry(from, to, path.join(relative, name)));
    }
    return written;
  }
  if (!isCopied(relative)) return [];
  const destination = path.join(to, relative);
  mkdirSync(path.dirname(destination), { recursive: true });
  cpSync(source, destination);
  return [relative];
}

export function copyTree(from, to, entries = COPY_ENTRIES) {
  return entries.flatMap((entry) => copyEntry(from, to, entry));
}

// --------------------------------------------------------- generated files

/**
 * package.json for the copy: same dependencies (it IS this app), a name of
 * their own, and only the scripts that still have something to run — the test
 * and e2e scripts would point at suites this folder does not carry.
 */
export function renderPackageJson(source, { name }) {
  const pkg = JSON.parse(source);
  const keep = ["init", "gen:families", "ready", "start", "dev", "build", "preview", "typecheck", "lint", "mock"];
  return `${JSON.stringify(
    {
      name,
      private: true,
      version: "0.1.0",
      type: "module",
      scripts: Object.fromEntries(keep.filter((s) => pkg.scripts[s]).map((s) => [s, pkg.scripts[s]])),
      engines: pkg.engines,
      dependencies: pkg.dependencies,
      devDependencies: Object.fromEntries(
        Object.entries(pkg.devDependencies).filter(([dep]) => !isTestOnlyDependency(dep)),
      ),
    },
    null,
    2,
  )}\n`;
}

const TEST_ONLY = [
  "@playwright/test", "@testing-library/jest-dom", "@testing-library/react",
  "@testing-library/user-event", "jsdom", "msw", "vitest",
];
export const isTestOnlyDependency = (dep) => TEST_ONLY.includes(dep);

/** tsconfig without the paths this copy does not carry (e2e, the test configs). */
export function renderTsconfig(source) {
  const config = JSON.parse(source);
  config.include = ["src", "agentic.config.ts", "vite.config.ts"];
  return `${JSON.stringify(config, null, 2)}\n`;
}

const splice = (text, start, end, replacement) => text.slice(0, start) + replacement + text.slice(end);

/** `families: { … }` + `mockTarget` + `agentEndpoint`, for the config literal. */
export function renderFamiliesBlock(answers, mockTargetId, agentEndpoint = null) {
  const lines = [
    "",
    "  // Per-family wiring, written by `npm run create` from your answers.",
    "  // mine = your backend · mock = the bundled demo backend (and the app says",
    "  // so on those screens) · hide = not rendered at all. Change any of them",
    "  // here; the app reads this file and nothing else.",
    "  families: {",
    ...Object.keys(answers)
      .sort()
      .map((family) => `    ${JSON.stringify(family)}: ${JSON.stringify(answers[family])},`),
    "  },",
  ];
  if (Object.values(answers).includes("mock")) {
    lines.push(`  mockTarget: ${JSON.stringify(mockTargetId)},`);
  }
  if (agentEndpoint) {
    lines.push(
      "",
      "  // Your agent, mapped onto the chat family by src/api/bareAgent.ts.",
      "  // It covers chat only, and its conversations live in the tab's memory",
      "  // until you implement the conversations family for real (stage 2).",
      `  agentEndpoint: { url: ${JSON.stringify(agentEndpoint.url)}, stream: ${JSON.stringify(agentEndpoint.stream)} },`,
    );
  }
  return `${lines.join("\n")}\n`;
}

/**
 * The generated agentic.config.ts — a text edit of this repo's own file, the
 * way scripts/init.mjs does it, so all ~150 lines of documentation in it
 * survive into the copy.
 *
 * localMock.enabled is NOT init.mjs's rule here: it boots whenever a family
 * answers `mock`, even though the app's default target is the adopter's
 * backend. That IS the split this generator exists to produce.
 */
export function applyGeneration(
  source,
  { product, init = null, answers, mockTargetId = "mock", agentEndpoint = null },
) {
  const productRange = valueRange(source, "product");
  let out = splice(
    source,
    productRange.start,
    productRange.end,
    [
      "{",
      `    name: ${JSON.stringify(product.name)},`,
      `    label: ${JSON.stringify(product.label)},`,
      `    trees: { one: ${JSON.stringify(product.trees.one)}, many: ${JSON.stringify(product.trees.many)} },`,
      "  }",
    ].join("\n"),
  );

  if (init) {
    const targets = valueRange(out, "targets");
    // A rules-based remap (item 40 — prefix + drop /agenttrees/ + resource
    // renames + split chat/stream route) replaces the plain-prefix comment
    // and `remap:` line renderInitBlock would otherwise derive.
    const remapLines = init.remapRules && !rulesAreEmpty(init.remapRules)
      ? [
          `  // conformance ${init.conformance.withRemap.conformant}/${init.conformance.withRemap.checked} operations with these path rules`,
          renderRemapField(init.remapRules),
        ]
      : null;
    const block = renderInitBlock(init, {
      header: [
        `// YOUR backend, written by \`npm run create\` from ${init.source}.`,
        "// baseUrl / remap / requiresToken were derived from its own OpenAPI —",
        "// edit freely; this file is yours.",
      ],
      remapLines,
    })
      .split("\n")
      .map((line) => (line ? `    ${line}` : line))
      .join("\n");
    out = splice(out, targets.start + 1, targets.start + 1, `\n${block}`);
    const dt = valueRange(out, "defaultTarget");
    out = splice(
      out,
      dt.start,
      dt.end,
      out.slice(dt.start, dt.end).replace(/dev:\s*"[^"]*"/, `dev: ${JSON.stringify(init.id)}`),
    );
  }

  const mocking = Object.values(answers).includes("mock");
  const localMock = valueRange(out, "localMock");
  out = splice(
    out,
    localMock.start,
    localMock.end,
    out
      .slice(localMock.start, localMock.end)
      .replace(/enabled:\s*(true|false)/, `enabled: ${mocking}`),
  );

  // The families block goes in after localMock's entry, which is where the
  // interface declares it.
  const after = out.indexOf("\n", valueRange(out, "localMock").end) + 1;
  return splice(out, after, after, renderFamiliesBlock(answers, mockTargetId, agentEndpoint));
}

// ------------------------------------------------------------------- detect

/**
 * Ask the backend for its spec — bare origin or a document URL/path.
 *
 * `rules` (scripts/remap-rules.mjs), when given and non-empty, REPLACES the
 * plain prefix auto-detection (buildInit's own detectPrefix) with the
 * adopter's own path rules — a fixed prefix alone can't express "the tree id
 * sits directly under the prefix, no literal /agenttrees/ segment" or a
 * renamed resource ("conversations" -> "sessions"), both real adopter shapes
 * (item 40). With no rules, behavior is exactly what it was before rules
 * existed.
 */
export async function detectBackend(source, contract, rules = null) {
  const candidates = /\.(json|ya?ml)$/i.test(source) || !/^https?:\/\//.test(source)
    ? [source]
    : [`${source.replace(/\/+$/, "")}/openapi.json`, `${source.replace(/\/+$/, "")}/openapi.yaml`];
  const errors = [];
  for (const candidate of candidates) {
    try {
      const target = await loadTarget(candidate, {});
      const { init, effective } = rules && !rulesAreEmpty(rules)
        ? buildInitFromRules(contract, target, { source: candidate, rules })
        : buildInit(contract, target, { source: candidate });
      return { init, report: effective, errors: [] };
    } catch (error) {
      errors.push(`  ${candidate} — ${error.message}`);
    }
  }
  return { init: null, report: null, errors };
}

/**
 * How a bare agent endpoint streams, when the flag did not say. A HEAD/GET
 * that answers `text/event-stream` is an SSE endpoint; anything else is
 * treated as plain JSON. Detection NEVER posts — probing someone's agent with
 * a made-up message would bill them for it.
 */
export async function detectStream(url, fetchImpl = fetch) {
  try {
    const res = await fetchImpl(url, { method: "GET" });
    const type = res.headers?.get?.("content-type") ?? "";
    if (type.includes("text/event-stream")) return { stream: "sse", source: "content-type" };
    if (type.includes("application/json")) return { stream: "json", source: "content-type" };
  } catch {
    // unreachable at generation time — the endpoint may not be up yet
  }
  return { stream: "sse", source: "assumed (token streaming is the common case)" };
}

// --------------------------------------------------------------------- write

/**
 * The write itself, as one function with no prompting in it — everything
 * else decides, this does. Exported so tests can generate a folder without
 * driving a questionnaire or the browser mapper.
 */
export function generate({ outDir, product, init = null, answers, agentEndpoint = null, contractVersion, from = ROOT }) {
  mkdirSync(outDir, { recursive: true });
  const written = copyTree(from, outDir);

  const config = applyGeneration(readFileSync(path.join(from, "agentic.config.ts"), "utf8"), {
    product,
    init,
    answers,
    mockTargetId: "mock",
    agentEndpoint,
  });
  writeFileSync(path.join(outDir, "agentic.config.ts"), config, "utf8");
  written.push("agentic.config.ts");

  writeFileSync(
    path.join(outDir, "package.json"),
    renderPackageJson(readFileSync(path.join(from, "package.json"), "utf8"), { name: `${product.name}-ui` }),
    "utf8",
  );
  written.push("package.json");

  writeFileSync(
    path.join(outDir, "tsconfig.json"),
    renderTsconfig(readFileSync(path.join(from, "tsconfig.json"), "utf8")),
    "utf8",
  );
  written.push("tsconfig.json");

  writeFileSync(
    path.join(outDir, "README.md"),
    renderReadme({
      product,
      answers,
      target: init ? { id: init.id, label: init.label, baseUrl: init.baseUrl } : null,
      agentEndpoint,
      contractVersion,
      needsPython: Object.values(answers).includes("mock"),
    }),
    "utf8",
  );
  written.push("README.md");

  return written;
}

// --------------------------------------------------------------------- main

/**
 * The `--yes` path: no prompts, no browser — every family takes its
 * suggested answer (or its `--family`/`--openapi`/`--agent-endpoint` flag),
 * and the folder is written if the answers are valid. This is the CI-safe
 * entry point and it is untouched by the browser mapper.
 */
export async function runNonInteractive({ options, contract, names, contractVersion }) {
  const tech = techReport();
  if (!tech.nodeOk) {
    console.error("create-app: Node >= 22.18 is required to run the generated app. Stopping.");
    return 1;
  }

  const label = options.name ?? "My Agent";
  const outDir = path.resolve(options.out ?? `${slugify(label)}-ui`);
  const [one, many] = (options.treeTerm ?? "").split(",");
  const treeOne = one?.trim() || "agent tree";
  const treeMany = many?.trim() || `${treeOne}s`;

  let backend = { init: null, report: null, errors: [] };
  let agentEndpoint = null;
  if (options.openapi) {
    backend = await detectBackend(options.openapi, contract);
  } else if (options.agentEndpoint) {
    const detected = options.stream
      ? { stream: options.stream, source: "--stream" }
      : await detectStream(options.agentEndpoint);
    agentEndpoint = { url: options.agentEndpoint, stream: detected.stream };
  }

  const suggested = suggestAnswers(names, { report: backend.report, agentEndpoint, flags: options.families });
  const answers = Object.fromEntries(names.map((name) => [name, suggested[name].answer]));

  const refusal = validateAnswers(answers);
  if (refusal) {
    console.error(`create-app: refusing to generate: ${refusal}.`);
    return 1;
  }
  if (existsSync(outDir) && readdirSync(outDir).length > 0 && !options.force) {
    console.error(`${outDir} already has files in it — pass --force to write into it anyway.`);
    return 1;
  }

  const written = generate({
    outDir,
    product: { name: slugify(label), label, trees: { one: treeOne, many: treeMany } },
    init: backend.init,
    answers,
    agentEndpoint,
    contractVersion,
  });

  if (options.json) {
    console.log(JSON.stringify({ outDir, answers, files: written.length }, null, 2));
  } else {
    console.log(
      [
        `Wrote ${written.length} files to ${outDir}.`,
        "",
        `  cd ${path.relative(process.cwd(), outDir) || "."}`,
        "  npm install",
        "  npm start",
        "",
        "Read README.md there first — it says what you own, what the mock is answering,",
        "and which endpoint to implement next.",
      ].join("\n"),
    );
  }
  return 0;
}
