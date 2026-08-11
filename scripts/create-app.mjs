#!/usr/bin/env node
// create-app — clone this repo, run ONE command, get a folder that `npm run`s
// a chat + studio UI for YOUR agent. TASKS.md item 11 (terminal); item 40
// replaced the terminal questionnaire with a local browser mapper. The flow
// is docs/plan-adopter-onboarding.md.
//
// Usage: npm run create -- [name] [options]
//   --out <dir>            where to write it (default ./<name>-ui)
//   --openapi <url|file>   your backend's OpenAPI document — its conformance
//                          per family becomes the suggested answers
//   --agent-endpoint <url> your agent's bare HTTP endpoint, for the common
//                          case of a framework agent with no OpenAPI at all
//   --stream sse|json      how that endpoint answers (default sse)
//   --family <n>=<answer>  mine | mock | hide, repeatable; `all` sets every
//                          family the other flags left unanswered
//   --tree-term <one>[,<many>]  what THIS product calls an agent tree
//   --yes                  never prompt, no browser: unanswered families
//                          take the suggested answer (a CI-safe run)
//   --force                write into a folder that already has files in it
//   --json                 machine-readable summary on stdout (--yes only)
// Exit codes: 0 written · 1 refused (bad answers, folder in the way) ·
//   2 error · 130 cancelled (browser tab closed, or Ctrl+C).
//
// WITHOUT --yes, this opens a local browser page (create-app-server.mjs +
// create-app-ui/index.html) to map families instead of a terminal
// questionnaire — same one-question-per-family model, same suggestions, just
// a page instead of a sequence of blocking prompts.
//
// THIS FILE IS THE CLI ENTRY POINT ONLY. Every decision function
// (suggestAnswers, validateAnswers, detectBackend, generate, …) lives in
// scripts/create-app-core.mjs and is re-exported below — see that file's own
// header for why the split exists (a real ESM circular-import deadlock, not
// a style preference). scripts/create-app-server.mjs, the browser mapper's
// HTTP transport, imports the same core module, never this one.
//
// THE ONE STRUCTURAL CHOICE: questions are per FAMILY, not per operation. The
// contract is 67 operations across 14 families and a stranger's backend
// matches almost none of them, so asking per endpoint would be 60+ questions
// on a first run. Families come from the contract's own tags — this script
// holds no list of its own.
//
// WHAT `mock` COSTS, said before anything is generated (item 10b): the bundled
// mock is Python/FastAPI, so a `mock` answer anywhere makes Python 3.11+ a
// prerequisite of the generated folder. A JS/TS agent developer meeting an
// unannounced pip install is exactly the bounce this flow exists to prevent.
//
// WHAT THE FOLDER IS: a COPY they own, with no upstream updates (item 8). The
// generated README says so in its second paragraph.

import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import SwaggerParser from "@apidevtools/swagger-parser";
import { families as contractFamilies } from "./conformance.mjs";

export * from "./create-app-core.mjs";
import { CONTRACT_FILE, USAGE, parseArgs, runNonInteractive } from "./create-app-core.mjs";

async function main(argv = process.argv.slice(2)) {
  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    console.error(`create-app: ${error.message}\n${USAGE}`);
    return 2;
  }
  if (options.help) {
    console.log(USAGE);
    return 0;
  }

  const contract = await SwaggerParser.dereference(CONTRACT_FILE);
  const names = contractFamilies(contract);
  const unknownFlags = Object.keys(options.families).filter((n) => n !== "all" && !names.includes(n));
  if (unknownFlags.length > 0) {
    console.error(
      `create-app: --family names a family this contract does not declare: ${unknownFlags.join(", ")}\n` +
        `  families: ${names.join(", ")}`,
    );
    return 2;
  }
  const contractVersion = contract.info?.version ?? "?";

  if (options.yes) {
    try {
      return await runNonInteractive({ options, contract, names, contractVersion });
    } catch (error) {
      console.error(`create-app: ${error.message}`);
      return 2;
    }
  }

  // Interactive default: a local browser page replaces the old terminal
  // questionnaire (item 40). Loaded lazily so `--yes`/CI runs never pay for
  // node:http or touch a socket.
  try {
    const { runInteractive } = await import("./create-app-server.mjs");
    const outcome = await runInteractive({ options, contract, names, contractVersion });
    if (outcome.code === 0 && outcome.result) {
      console.log(
        [
          `\nWrote ${outcome.result.written} files to ${outcome.result.outDir}.`,
          "",
          `  cd ${path.relative(process.cwd(), outcome.result.outDir) || "."}`,
          "  npm install",
          "  npm start",
          "",
          "Read README.md there first — it says what you own, what the mock is answering,",
          "and which endpoint to implement next.",
        ].join("\n"),
      );
    } else {
      console.log(`\n${outcome.reason ? `${outcome.reason} — ` : ""}Nothing written.`);
    }
    return outcome.code;
  } catch (error) {
    console.error(`create-app: ${error.message}`);
    return 2;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main();
}
