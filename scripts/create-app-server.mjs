#!/usr/bin/env node
// The browser-based family mapper for `npm run create` — replaces the old
// terminal questionnaire with an HTML page so mapping ~15 families
// to mine/mock/hide, plus the path rules a real backend needs
// (scripts/remap-rules.mjs), is a form instead of a sequence of
// blocking prompts. This file is transport only: every decision (suggested
// answers, validation, the write itself) stays in create-app-core.mjs's
// plain functions, imported here and never forked. Importing from THAT
// module rather than create-app.mjs (the CLI entry point) is deliberate —
// see create-app-core.mjs's header for the ESM circular-import deadlock
// that split them.
//
// Plain Node ESM, no new runtime dependency, no bundler — the page is one
// static HTML file with vanilla JS, served byte for byte, matching how the
// rest of scripts/ works (see cupel-ready.mjs's own header).

import { createServer } from "node:http";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { exec } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import {
  askOrder,
  detectBackend,
  detectStream,
  generate,
  suggestAnswers,
  techReport,
  validateAnswers,
} from "./create-app-core.mjs";
import { familyDescriptions } from "./conformance.mjs";
import { slugify } from "./init.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PAGE_FILE = path.join(HERE, "create-app-ui", "index.html");

// No ping for this long -> the tab is gone (closed, crashed, machine slept).
// Generous on purpose: mapping ~15 families by hand is not a 10-second job.
const DISCONNECT_MS = 90_000;

/** Operations per family, straight off the contract — table context only. */
export function operationCounts(contract) {
  const counts = {};
  for (const pathItem of Object.values(contract.paths ?? {})) {
    for (const op of Object.values(pathItem)) {
      if (!op || typeof op !== "object" || !Array.isArray(op.tags) || !op.tags.length) continue;
      const family = op.tags[0];
      counts[family] = (counts[family] ?? 0) + 1;
    }
  }
  return counts;
}

function openBrowser(url) {
  const command =
    process.platform === "win32"
      ? `start "" "${url}"`
      : process.platform === "darwin"
        ? `open "${url}"`
        : `xdg-open "${url}"`;
  exec(command, () => {
    // Best-effort: a failed open just means the adopter opens the URL
    // themselves — it is printed to the terminal either way.
  });
}

function sendJson(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(text),
  });
  res.end(text);
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => {
      data += chunk;
    });
    req.on("end", () => {
      if (!data) return resolve({});
      try {
        resolve(JSON.parse(data));
      } catch (error) {
        reject(new Error(`invalid JSON body: ${error.message}`));
      }
    });
    req.on("error", reject);
  });
}

/** Normalizes whatever the page sent into a rules object remap-rules.mjs understands. */
function readRules(raw) {
  if (!raw || typeof raw !== "object") return null;
  return {
    prefix: typeof raw.prefix === "string" ? raw.prefix.trim() : "",
    dropAgenttrees: Boolean(raw.dropAgenttrees),
    renames: Array.isArray(raw.renames)
      ? raw.renames
          .map((r) => ({ from: String(r?.from ?? "").trim(), to: String(r?.to ?? "").trim() }))
          .filter((r) => r.from)
      : [],
    splitStream: Boolean(raw.splitStream),
    streamSuffix: typeof raw.streamSuffix === "string" && raw.streamSuffix.trim() ? raw.streamSuffix.trim() : "stream",
  };
}

/**
 * Runs the browser flow end to end and resolves with the CLI's outcome:
 * `{code, result, reason}`. `options` are the pre-parsed CLI flags — they
 * seed the page's defaults but stay editable there; nothing is written until
 * POST /api/generate.
 */
export async function runInteractive({ options, contract, names, contractVersion }) {
  const descriptions = familyDescriptions(contract);
  const counts = operationCounts(contract);
  const tech = techReport();
  const html = readFileSync(PAGE_FILE, "utf8");

  let settle;
  const done = new Promise((resolve) => {
    settle = resolve;
  });
  let settled = false;
  const finish = (outcome) => {
    if (settled) return;
    settled = true;
    settle(outcome);
  };

  let lastPing = Date.now();

  const server = createServer(async (req, res) => {
    let url;
    try {
      url = new URL(req.url, "http://127.0.0.1");
    } catch {
      res.writeHead(400).end();
      return;
    }

    try {
      if (req.method === "GET" && url.pathname === "/") {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(html);
        return;
      }

      if (req.method === "GET" && url.pathname === "/api/bootstrap") {
        const [treeOne, treeMany] = (options.treeTerm ?? "").split(",").map((s) => s?.trim() ?? "");
        return sendJson(res, 200, {
          contractVersion,
          families: askOrder(names),
          descriptions,
          counts,
          tech: { lines: tech.lines, nodeOk: tech.nodeOk, pythonOk: tech.pythonOk },
          defaults: {
            name: options.name ?? "",
            out: options.out ?? "",
            treeOne: treeOne || "",
            treeMany: treeMany || "",
            openapi: options.openapi ?? "",
            agentEndpoint: options.agentEndpoint ?? "",
            stream: options.stream ?? "sse",
            familyFlags: options.families ?? {},
          },
        });
      }

      if (req.method === "POST" && url.pathname === "/api/ping") {
        lastPing = Date.now();
        return sendJson(res, 200, { ok: true });
      }

      if (req.method === "POST" && url.pathname === "/api/detect") {
        const body = await readJsonBody(req);
        if (body.mode === "openapi" && body.source) {
          const rules = readRules(body.rules);
          // `pick` comes back from an `alternatives` entry the human clicked.
          const pick =
            body.pick && Number.isInteger(body.pick.depth) && typeof body.pick.prefix === "string"
              ? { depth: body.pick.depth, prefix: body.pick.prefix }
              : null;
          const backend = await detectBackend(body.source, contract, rules, { pick });
          const suggested = suggestAnswers(names, { report: backend.report, flags: options.families });
          return sendJson(res, 200, {
            init: backend.init,
            report: backend.report ? { conformant: backend.report.conformant, checked: backend.report.checked } : null,
            // What the spec itself said about their agents — prefix, ids, the
            // noun behind those ids, the split stream route. The page renders
            // this instead of asking for any of it.
            shape: backend.shape,
            rulesFrom: backend.rulesFrom,
            errors: backend.errors,
            suggested,
          });
        }
        if (body.mode === "agent" && body.url) {
          const detected = body.stream ? { stream: body.stream, source: "you chose" } : await detectStream(body.url);
          const agentEndpoint = { url: body.url, stream: detected.stream };
          const suggested = suggestAnswers(names, { agentEndpoint, flags: options.families });
          return sendJson(res, 200, { agentEndpoint, streamSource: detected.source, suggested });
        }
        // No backend at all — persona A, the product demo.
        const suggested = suggestAnswers(names, { flags: options.families });
        return sendJson(res, 200, { init: null, agentEndpoint: null, suggested });
      }

      if (req.method === "POST" && url.pathname === "/api/generate") {
        const body = await readJsonBody(req);
        const refusal = validateAnswers(body.answers ?? {});
        if (refusal) return sendJson(res, 400, { error: refusal });
        const label = (body.name ?? "").trim();
        if (!label) return sendJson(res, 400, { error: "product name is required" });

        const slug = slugify(label);
        const outDir = path.resolve(body.out || `${slug}-ui`);
        if (existsSync(outDir) && readdirSync(outDir).length > 0 && !body.force) {
          return sendJson(res, 409, { error: `${outDir} already has files in it`, outDir });
        }

        const treeOne = (body.treeOne || "").trim() || "agent tree";
        const treeMany = (body.treeMany || "").trim() || `${treeOne}s`;
        const written = generate({
          outDir,
          product: { name: slug, label, trees: { one: treeOne, many: treeMany } },
          init: body.init ?? null,
          answers: body.answers,
          agentEndpoint: body.agentEndpoint ?? null,
          contractVersion,
        });

        const result = {
          outDir,
          written: written.length,
          mocked: Object.keys(body.answers).filter((f) => body.answers[f] === "mock"),
        };
        sendJson(res, 200, result);
        finish({ code: 0, result });
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/cancel") {
        sendJson(res, 200, { ok: true });
        finish({ code: 130, result: null, reason: "Cancelled" });
        return;
      }

      res.writeHead(404).end();
    } catch (error) {
      sendJson(res, 500, { error: error.message });
    }
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  const url = `http://127.0.0.1:${port}/`;
  console.log(`\nGenerating a chat + studio UI you own. Nothing is written until you click Generate.`);
  if (process.env.CUPEL_CREATE_NO_OPEN) {
    // Headless / remote dev (SSH, a container with no display, CI smoke
    // tests): opening a GUI browser would just fail silently, so skip it and
    // trust whoever set this knows to open the URL themselves.
    console.log(`Open ${url} in a browser — CUPEL_CREATE_NO_OPEN is set, so it was not opened for you.`);
  } else {
    console.log(`Opening ${url} — if it doesn't open, paste that into a browser.`);
    openBrowser(url);
  }
  console.log("(Ctrl+C here cancels, same as closing the tab.)\n");

  const disconnectTimer = setInterval(() => {
    if (Date.now() - lastPing > DISCONNECT_MS) finish({ code: 130, result: null, reason: "Browser disconnected" });
  }, 5_000);

  const onSigint = () => finish({ code: 130, result: null, reason: "Cancelled" });
  process.once("SIGINT", onSigint);

  const outcome = await done;
  clearInterval(disconnectTimer);
  process.off("SIGINT", onSigint);
  server.close();
  return outcome;
}
