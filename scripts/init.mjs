#!/usr/bin/env node
// PW-1 whitelabel-lite — `npm run init`: the ONE command that puts an
// adopter's name on the app. Asks three things (product name, what this
// deployment calls an agent tree, the backend URL) and rewrites
// agentic.config.ts, the one config artifact.
//
// Backend detection is NOT reimplemented here: the URL is handed to
// scripts/cupel-ready.mjs, whose --init logic already derives baseUrl, a path
// prefix remap and the auth scheme from the backend's own OpenAPI and renders
// the target block. cupel-ready itself still never writes the config (it says
// so in its own header) — this script is the sanctioned writer, and it edits
// the existing file in place so every hand-written comment, extra target and
// compareSet survives.
//
// Nothing is written until every question is answered and the final
// confirmation is given: aborting at any prompt (Ctrl+C, EOF, "n") leaves the
// file untouched. The write itself goes to a temp file and is renamed over the
// original, after a copy is kept at agentic.config.ts.bak.

import { readFileSync, writeFileSync, renameSync, copyFileSync, existsSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import process from "node:process";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import SwaggerParser from "@apidevtools/swagger-parser";
import { buildInit, renderInitBlock, deriveIdentity, loadTarget } from "./cupel-ready.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const CONFIG_FILE = path.join(ROOT, "agentic.config.ts");
const CONTRACT_FILE = path.join(ROOT, "openapi.yaml");

// --------------------------------------------------------------- answer shapes

/** "My Product" -> "my-product": the machine-side `product.name`. */
export function slugify(label) {
  return (
    label
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "app"
  );
}

/** Suggested plural, offered as the prompt's default so it can be overridden. */
export function pluralize(one) {
  const term = one.trim();
  if (/(s|x|z|ch|sh)$/i.test(term)) return `${term}es`;
  if (/[^aeiou]y$/i.test(term)) return `${term.slice(0, -1)}ies`;
  return `${term}s`;
}

// ------------------------------------------------- agentic.config.ts rewriting
// A source-text edit, not a regeneration: the file carries ~150 lines of
// hand-written documentation that a generator would throw away. The scanner
// below is delimiter-counting and string/comment aware, which is all this
// file's literals need — it is deliberately not a TypeScript parser.

function skipString(source, at) {
  const quote = source[at];
  for (let i = at + 1; i < source.length; i++) {
    if (source[i] === "\\") {
      i++;
      continue;
    }
    if (source[i] === quote) return i;
  }
  throw new Error("agentic.config.ts: unterminated string literal");
}

const OPENERS = "{[(";
const CLOSERS = "}])";

/**
 * [start, end) of the value assigned to a TOP-LEVEL key of the `agenticConfig`
 * literal — the text between "key: " and its trailing comma.
 */
export function valueRange(source, key) {
  const constAt = source.indexOf("export const agenticConfig");
  if (constAt < 0) throw new Error("agentic.config.ts: no `export const agenticConfig`");
  const marker = `\n  ${key}: `;
  const at = source.indexOf(marker, constAt);
  if (at < 0) throw new Error(`agentic.config.ts: no top-level \`${key}\` in agenticConfig`);
  const start = at + marker.length;
  let depth = 0;
  for (let i = start; i < source.length; i++) {
    const ch = source[i];
    if (ch === "/" && source[i + 1] === "/") {
      const nl = source.indexOf("\n", i);
      i = nl < 0 ? source.length : nl;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      i = skipString(source, i);
      continue;
    }
    if (OPENERS.includes(ch)) depth++;
    else if (CLOSERS.includes(ch)) {
      if (depth === 0) return { start, end: i }; // hit the closing `}` of agenticConfig
      depth--;
    } else if (ch === "," && depth === 0) return { start, end: i };
  }
  throw new Error(`agentic.config.ts: unterminated value for \`${key}\``);
}

/**
 * Top-level element ranges of an array literal. A comment attaches to the
 * element that FOLLOWS it, so replacing an entry takes its own comment with it
 * instead of orphaning one.
 */
export function arrayElements(source, { start, end }) {
  const elements = [];
  let depth = 0;
  let elementStart = null;
  for (let i = start + 1; i < end; i++) {
    const ch = source[i];
    if (/\s/.test(ch)) continue;
    if (depth === 0 && CLOSERS.includes(ch)) {
      // the array's own closing bracket
      if (elementStart !== null) elements.push({ start: elementStart, end: i });
      return elements;
    }
    if (elementStart === null) elementStart = i;
    if (ch === "/" && source[i + 1] === "/") {
      const nl = source.indexOf("\n", i);
      i = nl < 0 ? end : nl;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      i = skipString(source, i);
      continue;
    }
    if (OPENERS.includes(ch)) depth++;
    else if (CLOSERS.includes(ch)) depth--;
    else if (ch === "," && depth === 0) {
      elements.push({ start: elementStart, end: i + 1 });
      elementStart = null;
    }
  }
  if (elementStart !== null) elements.push({ start: elementStart, end });
  return elements;
}

const splice = (source, start, end, text) => source.slice(0, start) + text + source.slice(end);

const indent = (text, spaces) =>
  text
    .split("\n")
    .map((line) => (line ? " ".repeat(spaces) + line : line))
    .join("\n");

export function renderProductBlock({ name, label, trees }) {
  return [
    "{",
    `    name: ${JSON.stringify(name)},`,
    `    label: ${JSON.stringify(label)},`,
    `    trees: { one: ${JSON.stringify(trees.one)}, many: ${JSON.stringify(trees.many)} },`,
    "  }",
  ].join("\n");
}

/** The target block, rendered by cupel-ready with an init-specific header. */
export function renderTargetBlock(init) {
  return renderInitBlock(init, {
    header: [
      `// Written by \`npm run init\` from ${init.source}.`,
      "// baseUrl / remap / requiresToken were derived from that backend's own",
      "// OpenAPI (the same detection as `cupel-ready --init`) — edit freely.",
    ],
  });
}

/**
 * The whole write logic as one pure text transform, so it is testable without
 * any prompting: product block, the adopter's target (replacing a same-id
 * entry rather than duplicating it), defaultTarget.dev, and localMock.enabled
 * — which only goes false when the chosen backend is not the bundled mock,
 * because pointing at your own backend is exactly when `npm start` must stop
 * booting the demo one.
 */
export function applyAnswers(source, { product, init }) {
  const productRange = valueRange(source, "product");
  let out = splice(source, productRange.start, productRange.end, renderProductBlock(product));

  const targets = valueRange(out, "targets");
  const block = indent(renderTargetBlock(init), 4);
  const idKey = `id: ${JSON.stringify(init.id)}`;
  const existing = arrayElements(out, targets).find((el) => out.slice(el.start, el.end).includes(idKey));
  out = existing
    ? splice(out, existing.start, existing.end, block.trimStart())
    : splice(out, targets.start + 1, targets.start + 1, `\n${block}`);

  const dt = valueRange(out, "defaultTarget");
  out = splice(
    out,
    dt.start,
    dt.end,
    out.slice(dt.start, dt.end).replace(/dev:\s*"[^"]*"/, `dev: ${JSON.stringify(init.id)}`),
  );

  if (!init.isBundledMock) {
    const lm = valueRange(out, "localMock");
    out = splice(
      out,
      lm.start,
      lm.end,
      out.slice(lm.start, lm.end).replace(/enabled:\s*true/, "enabled: false"),
    );
  }
  return out;
}

/**
 * Write with a .bak copy first, then temp-file + rename, so a crash mid-write
 * cannot leave a half-written config artifact behind.
 */
export function writeConfig(file, text) {
  if (existsSync(file)) copyFileSync(file, `${file}.bak`);
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, text, "utf8");
  renameSync(tmp, file);
}

// ------------------------------------------------------------------ detection

/** Spec URLs to try for a bare backend origin, in order. */
export function specCandidates(url) {
  const trimmed = url.trim().replace(/\/+$/, "");
  if (/\.(json|ya?ml)$/i.test(trimmed)) return [trimmed];
  return [`${trimmed}/openapi.json`, `${trimmed}/openapi.yaml`];
}

/**
 * Reuse of `cupel-ready --init`: fetch the backend's OpenAPI and derive the
 * target block from it. When the backend is unreachable we do NOT guess a
 * remap or an auth scheme — we fall back to a bare target carrying only the
 * URL the user typed, and say so.
 */
async function detectTarget(url, contract) {
  const errors = [];
  for (const source of specCandidates(url)) {
    try {
      const target = await loadTarget(source, {});
      const { init } = buildInit(contract, target, { source });
      return { init, source, detected: true };
    } catch (error) {
      errors.push(`  ${source} — ${error.message}`);
    }
  }
  const baseUrl = url.trim().replace(/\/+$/, "");
  const identity = deriveIdentity(baseUrl);
  return {
    detected: false,
    errors,
    init: {
      source: `${baseUrl} (no OpenAPI reachable)`,
      ...identity,
      baseUrl,
      baseUrlComment: "the URL given to `npm run init` (the backend was not reachable to confirm it)",
      requiresToken: false,
      authSchemes: [],
      remapPrefix: null,
      remapNote: "backend not reachable at init time -- set remap by hand if its routes are prefixed",
      conformance: { withoutRemap: { conformant: 0, checked: 0 }, withRemap: null },
    },
  };
}

// ---------------------------------------------------------------- interactive

/**
 * Prompter over readline. `rl.question()` alone drops input that arrives while
 * no question is pending and never settles once stdin ends, so a piped run
 * (`printf '…' | npm run init`) loses answers and then hangs; this queues the
 * lines instead and turns end-of-input into a rejection the caller treats as
 * an abort.
 */
export function createPrompter(input, output) {
  const rl = createInterface({ input, output });
  const waiting = [];
  const buffered = [];
  let closed = false;

  rl.on("line", (line) => {
    const next = waiting.shift();
    if (next) next.resolve(line);
    else buffered.push(line);
  });
  rl.on("close", () => {
    closed = true;
    while (waiting.length) waiting.shift().reject(new Error("input closed"));
  });

  return {
    question(text) {
      output.write(text);
      if (buffered.length) {
        const line = buffered.shift();
        output.write(`${line}\n`);
        return Promise.resolve(line);
      }
      if (closed) return Promise.reject(new Error("input closed"));
      return new Promise((resolve, reject) => waiting.push({ resolve, reject }));
    },
    close: () => rl.close(),
  };
}

async function main() {
  const source = readFileSync(CONFIG_FILE, "utf8");
  const current = (await import(pathToFileURL(CONFIG_FILE).href)).agenticConfig;
  const rl = createPrompter(process.stdin, process.stdout);

  const ask = async (question, fallback) => {
    const answer = (await rl.question(`${question} [${fallback}]: `)).trim();
    return answer || fallback;
  };

  let answers;
  try {
    console.log("\nPutting your name on this checkout — writes agentic.config.ts.\n");
    const label = await ask("Product name", current.product.label);
    const currentTrees = current.product.trees;
    const one = await ask("What do you call one agent tree", currentTrees?.one ?? "agent tree");
    // Only offer the config's stored plural when the singular is unchanged —
    // otherwise it would suggest the OLD term's plural for the NEW word.
    const many = await ask(
      "...and more than one",
      one === currentTrees?.one ? currentTrees.many : pluralize(one),
    );
    const url = await ask("Backend URL", current.targets[0]?.baseUrl || "http://localhost:4010");
    answers = { product: { name: slugify(label), label, trees: { one, many } }, url };
  } catch {
    rl.close();
    console.error("\nAborted — agentic.config.ts is unchanged.");
    return 130;
  }

  const contract = await SwaggerParser.dereference(CONTRACT_FILE);
  console.log(`\nProbing ${answers.url} …`);
  const { init, detected, errors } = await detectTarget(answers.url, contract);
  init.isBundledMock = init.baseUrl === `http://localhost:${current.localMock.port}`;

  if (detected) {
    const { conformant, checked } = init.conformance.withRemap ?? init.conformance.withoutRemap;
    console.log(
      [
        `  spec        ${init.source}`,
        `  baseUrl     ${init.baseUrl || "(same-origin)"}`,
        `  remap       ${init.remapPrefix ? `${init.remapPrefix} + path` : "none detected"}`,
        `  auth        ${init.requiresToken ? init.authSchemes.map((s) => s.name).join(", ") : "none declared"}`,
        `  conformance ${conformant}/${checked} operations`,
      ].join("\n"),
    );
  } else {
    console.log(["  no OpenAPI could be read:", ...errors, "  writing a plain target — run `npm run ready <spec>` once it is up."].join("\n"));
  }

  console.log(
    [
      "",
      `product     ${answers.product.label} (${answers.product.name})`,
      `agent trees ${answers.product.trees.one} / ${answers.product.trees.many}`,
      `target      ${init.id} → ${init.baseUrl || "(same-origin)"}`,
      init.isBundledMock ? "localMock   left enabled (that URL is the bundled demo backend)" : "localMock   disabled — your backend holds persistence",
      "",
    ].join("\n"),
  );

  let go;
  try {
    go = (await rl.question("Write agentic.config.ts? (a copy is kept as .bak) [y/N]: ")).trim().toLowerCase();
  } catch {
    go = "";
  }
  rl.close();
  if (go !== "y" && go !== "yes") {
    console.log("Nothing written — agentic.config.ts is unchanged.");
    return 0;
  }

  writeConfig(CONFIG_FILE, applyAnswers(source, { product: answers.product, init }));
  console.log(`\nWrote ${CONFIG_FILE} (previous version: agentic.config.ts.bak).`);
  console.log("Run `npm start` to see it, `npm test` to check nothing broke.");
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main();
}
