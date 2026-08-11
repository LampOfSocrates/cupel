import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, readFileSync, rmSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import YAML from "yaml";
import {
  ANSWERS,
  applyGeneration,
  askOrder,
  copyTree,
  detectBackend,
  detectStream,
  generate,
  isCopied,
  nodeOk,
  parseArgs,
  renderFamiliesBlock,
  renderPackageJson,
  renderTsconfig,
  suggestAnswers,
  techReport,
  validateAnswers,
} from "../scripts/create-app.mjs";
import { renderReadme } from "../scripts/generated-readme.mjs";

// `npm run create` — one command, a folder the adopter owns
// (docs/plan-adopter-onboarding.md). The questionnaire is per FAMILY, and the
// family list is the contract's, so nothing here restates one.

const contract = YAML.parse(readFileSync("openapi.yaml", "utf8"));
const FAMILIES = contract.tags.map((t) => t.name);

describe("arguments", () => {
  it("takes a name, an output folder and per-family answers", () => {
    const options = parseArgs([
      "My Agent", "--out", "../mine", "--family", "chat=mine", "--family", "eval=hide", "--yes",
    ]);
    expect(options).toMatchObject({
      name: "My Agent",
      out: "../mine",
      families: { chat: "mine", eval: "hide" },
      yes: true,
    });
  });

  it("refuses an answer that is not mine/mock/hide", () => {
    expect(() => parseArgs(["--family", "chat=maybe"])).toThrow(/not mine, mock or hide/);
    expect(() => parseArgs(["--family", "chat"])).toThrow(/name=mine\|mock\|hide/);
  });

  // Two answers to "where does your backend live" is a mistake worth catching
  // at the flag, not at generation time.
  it("refuses an OpenAPI document and a bare endpoint together", () => {
    expect(() => parseArgs(["--openapi", "u", "--agent-endpoint", "v"])).toThrow(/pick one/);
  });

  it("refuses --stream without the endpoint it describes", () => {
    expect(() => parseArgs(["--stream", "sse"])).toThrow(/--agent-endpoint/);
    expect(() => parseArgs(["--agent-endpoint", "u", "--stream", "grpc"])).toThrow(/sse or json/);
  });
});

describe("the tech check", () => {
  it("states the Python prerequisite before anything is generated (item 10b)", () => {
    const report = techReport({ node: "24.0.0", python: null });
    expect(report.lines.join("\n")).toMatch(/MISS Python .*3\.11\+/);
    expect(report.pythonOk).toBe(false);
  });

  it("accepts a Python new enough for the bundled mock", () => {
    const report = techReport({
      node: "24.0.0",
      python: { command: "python3", version: "3.12.1", major: 3, minor: 12 },
    });
    expect(report.pythonOk).toBe(true);
    expect(report.lines.join("\n")).toMatch(/ok\s+Python 3\.12\.1/);
  });

  it("knows which Node versions can run the generated app", () => {
    expect(nodeOk("22.18.0")).toBe(true);
    expect(nodeOk("24.1.0")).toBe(true);
    expect(nodeOk("22.17.0")).toBe(false);
    expect(nodeOk("20.19.0")).toBe(false);
  });
});

describe("suggested answers", () => {
  it("asks about every family of the contract and nothing else", () => {
    expect(askOrder(FAMILIES).sort()).toEqual([...FAMILIES].sort());
    // chat first: it is the wedge persona's whole reason for being here.
    expect(askOrder(FAMILIES)[0]).toBe("chat");
  });

  it("mocks everything when there is no backend at all (persona A)", () => {
    const suggested = suggestAnswers(FAMILIES);
    expect(Object.values(suggested).every((s) => s.answer === "mock")).toBe(true);
  });

  // Persona B — a framework agent on HTTP and no spec. One family is theirs.
  it("gives chat to a bare agent endpoint and mocks the rest (persona B)", () => {
    const suggested = suggestAnswers(FAMILIES, { agentEndpoint: { url: "http://x", stream: "sse" } });
    expect(suggested.chat.answer).toBe("mine");
    expect(suggested.conversations.answer).toBe("mock");
  });

  // Persona C — partial overlap. A half-reachable family is a half-working
  // screen, which is worse than an honest mock, so only `full` becomes `mine`.
  it("follows the conformance verdict per family (persona C)", () => {
    const report = {
      families: [
        { name: "chat", status: "full", operations: 3, conformant: 3 },
        { name: "conversations", status: "partial", operations: 5, conformant: 2 },
        { name: "eval", status: "none", operations: 19, conformant: 0 },
      ],
    };
    const suggested = suggestAnswers(FAMILIES, { report });
    expect(suggested.chat).toMatchObject({ answer: "mine" });
    expect(suggested.conversations).toMatchObject({ answer: "mock", source: "your backend has 2/5" });
    expect(suggested.eval.answer).toBe("mock");
    // A family the spec does not mention at all still gets an answer.
    expect(suggested.memory.answer).toBe("mock");
  });

  it("lets a flag override the suggestion, and `all` cover the rest", () => {
    const suggested = suggestAnswers(FAMILIES, { flags: { all: "hide", chat: "mine" } });
    expect(suggested.chat.answer).toBe("mine");
    expect(suggested.eval.answer).toBe("hide");
  });
});

describe("refusals", () => {
  const all = (answer) => Object.fromEntries(FAMILIES.map((f) => [f, answer]));

  it("refuses a set of answers that leaves no screens", () => {
    expect(validateAnswers(all("hide"))).toMatch(/no screens/);
    expect(validateAnswers({ ...all("hide"), meta: "mock" })).toMatch(/screen-bearing/);
  });

  it("accepts one door being enough", () => {
    expect(validateAnswers({ ...all("hide"), chat: "mine" })).toBeNull();
  });
});

describe("what lands in the folder", () => {
  it("leaves Cupel's own suites behind — they assert Cupel's answers", () => {
    expect(isCopied("src/api/client.ts")).toBe(true);
    expect(isCopied("src/api/client.test.ts")).toBe(false);
    expect(isCopied("src\\shell\\Shell.test.tsx")).toBe(false);
    expect(isCopied("src/test/msw/handlers.ts")).toBe(false);
    expect(isCopied("mock/tests/test_chat.py")).toBe(false);
  });

  it("leaves build and machine artefacts behind", () => {
    expect(isCopied("mock/__pycache__/main.cpython-313.pyc")).toBe(false);
    expect(isCopied("mock/cupel-mock.sqlite")).toBe(false);
    expect(isCopied("mock/main.py")).toBe(true);
  });
});

describe("the generated package.json", () => {
  const pkg = JSON.parse(
    renderPackageJson(readFileSync("package.json", "utf8"), { name: "acme-ui" }),
  );

  it("is theirs, private, and runs only what the folder carries", () => {
    expect(pkg.name).toBe("acme-ui");
    expect(pkg.private).toBe(true);
    expect(pkg.scripts.start).toBeDefined();
    expect(pkg.scripts.ready).toBeDefined();
    // No suites in the folder, so no scripts pointing at them.
    expect(pkg.scripts.test).toBeUndefined();
    expect(pkg.scripts.e2e).toBeUndefined();
  });

  it("drops the test-only dependencies with them", () => {
    expect(pkg.devDependencies.vitest).toBeUndefined();
    expect(pkg.devDependencies.msw).toBeUndefined();
    expect(pkg.devDependencies["@playwright/test"]).toBeUndefined();
    expect(pkg.devDependencies.vite).toBeDefined();
    expect(pkg.dependencies["@mantine/core"]).toBeDefined();
  });

  it("points tsconfig at what the folder actually has", () => {
    expect(JSON.parse(renderTsconfig(readFileSync("tsconfig.json", "utf8"))).include).toEqual([
      "src",
      "agentic.config.ts",
      "vite.config.ts",
    ]);
  });
});

describe("the generated config", () => {
  const source = readFileSync("agentic.config.ts", "utf8");
  const answers = { chat: "mine", conversations: "mock", eval: "hide" };
  const product = { name: "acme", label: "Acme", trees: { one: "workspace", many: "workspaces" } };

  it("writes the answers and keeps the file's own documentation", () => {
    const out = applyGeneration(source, { product, answers });
    expect(out).toContain('"chat": "mine"');
    expect(out).toContain('"eval": "hide"');
    expect(out).toContain("mockTarget:");
    // The ~150 lines of comments are the reason this is a text edit.
    expect(out).toContain("THE one config artifact");
    expect(out).toContain('label: "Acme"');
    expect(out).toContain('trees: { one: "workspace", many: "workspaces" }');
  });

  // The whole point of the split: the mock boots even though the app's default
  // target is the adopter's own backend.
  it("boots the bundled mock whenever a family answers mock", () => {
    const withMock = applyGeneration(source, { product, answers });
    expect(/localMock: \{\s*\n\s*enabled: true/.test(withMock)).toBe(true);
    const withoutMock = applyGeneration(source, {
      product,
      answers: { chat: "mine", eval: "hide" },
    });
    expect(/localMock: \{\s*\n\s*enabled: false/.test(withoutMock)).toBe(true);
    expect(withoutMock).not.toContain("mockTarget:");
  });

  // Persona B: no spec to derive a target from, one endpoint to point at.
  it("writes a bare agent endpoint for the shim to read", () => {
    const out = applyGeneration(source, {
      product,
      answers: { ...answers, chat: "mine" },
      agentEndpoint: { url: "http://localhost:9000/chat", stream: "sse" },
    });
    expect(out).toContain('agentEndpoint: { url: "http://localhost:9000/chat", stream: "sse" }');
    expect(out).toContain("src/api/bareAgent.ts");
    expect(applyGeneration(source, { product, answers })).not.toContain("agentEndpoint:");
  });

  it("renders the answers sorted, so a regenerated config diffs cleanly", () => {
    const block = renderFamiliesBlock({ eval: "hide", chat: "mine" }, "mock");
    expect(block.indexOf('"chat"')).toBeLessThan(block.indexOf('"eval"'));
  });

  // item 40 — a backend whose routes need more than a prefix (renamed
  // resource, dropped "agenttrees" segment, chat streaming on its own route).
  it("writes a rules-based remap instead of the plain-prefix shape", () => {
    const init = {
      id: "nabu",
      label: "Nabu",
      baseUrl: "http://localhost:9999",
      baseUrlSource: "servers",
      requiresToken: false,
      authSchemes: [],
      remapRules: {
        prefix: "nabu-service",
        dropAgenttrees: true,
        renames: [{ from: "conversations", to: "sessions" }],
        splitStream: true,
        streamSuffix: "stream",
      },
      remapPrefix: null,
      remapNote: null,
      conformance: { withoutRemap: null, withRemap: { conformant: 3, checked: 3 } },
    };
    const out = applyGeneration(source, {
      product,
      init,
      answers: { ...answers, chat: "mine", conversations: "mine" },
    });
    expect(out).toContain('"conversations":"sessions"');
    expect(out).toContain("opts?.stream");
    expect(out).toContain("with these path rules");
    expect(out).not.toContain('remap: (p) => "/nabu-service" + p,');
  });
});

describe("the generated README", () => {
  const readme = renderReadme({
    product: { name: "acme", label: "Acme" },
    answers: { chat: "mine", conversations: "mock", eval: "hide" },
    target: { id: "acme", label: "Acme", baseUrl: "http://localhost:8000" },
    contractVersion: "0.4.0",
    needsPython: true,
  });

  // Item 8: the cost the adopter is consenting to, said plainly.
  it("says the copy receives no upstream fixes", () => {
    expect(readme).toMatch(/will not receive upstream fixes/i);
  });

  // Item 10b: the prerequisite is declared, not discovered at first run.
  it("declares the Python prerequisite and why it is there", () => {
    expect(readme).toMatch(/Python 3\.11\+/);
    expect(readme).toMatch(/served by the bundled mock/i);
  });

  it("carries the four-stage ladder and where the adopter stands on it", () => {
    expect(readme).toMatch(/Chat only — one endpoint/);
    expect(readme).toMatch(/Persistence — conversations and turns/);
    expect(readme).toMatch(/The studio — agents, instructions, versions/);
    expect(readme).toMatch(/Evaluations and traces/);
    expect(readme).toMatch(/You are at \*\*stage 2\*\*/);
  });

  it("names the hidden families as hidden and the mocked ones as mocked", () => {
    expect(readme).toMatch(/Hidden \(eval\)/);
    expect(readme).toMatch(/\| `conversations` \| mock \| the bundled mock \|/);
  });

  it("does not send the adopter to documents that are not in the folder", () => {
    expect(readme).not.toMatch(/persistence\.md|docs\//);
  });

  it("drops the Python paragraph when nothing is mocked", () => {
    const noMock = renderReadme({
      product: { name: "acme", label: "Acme" },
      answers: { chat: "mine" },
      contractVersion: "0.4.0",
      needsPython: false,
    });
    expect(noMock).toMatch(/No Python needed/);
  });
});

describe("a full generation", () => {
  let out;
  beforeAll(() => {
    out = mkdtempSync(path.join(tmpdir(), "cupel-create-"));
    generate({
      outDir: out,
      product: { name: "acme", label: "Acme", trees: { one: "workspace", many: "workspaces" } },
      answers: Object.fromEntries(FAMILIES.map((f) => [f, f === "chat" ? "mine" : "mock"])),
      contractVersion: contract.info.version,
    });
  });
  afterAll(() => rmSync(out, { recursive: true, force: true }));

  it("writes a folder that can be installed and run", () => {
    for (const file of [
      "package.json", "tsconfig.json", "vite.config.ts", "index.html", "README.md",
      "agentic.config.ts", "openapi.yaml", "src/App.tsx", "src/api/client.ts",
      "src/api/families.generated.ts", "mock/main.py", "scripts/dev.mjs",
    ]) {
      expect(existsSync(path.join(out, file)), file).toBe(true);
    }
  });

  it("carries no test suite and no repo-internal papers", () => {
    for (const file of ["tests", "e2e", "docs", "vitest.config.ts", "src/test", "TASKS.md"]) {
      expect(existsSync(path.join(out, file)), file).toBe(false);
    }
  });

  // The config is executable TypeScript, and Node strips types — so this reads
  // the generated file the way the app itself will.
  it("produces a config the app can actually load", async () => {
    const { agenticConfig } = await import(pathToFileURL(path.join(out, "agentic.config.ts")).href);
    expect(agenticConfig.product).toMatchObject({ name: "acme", label: "Acme" });
    expect(agenticConfig.families.chat).toBe("mine");
    expect(agenticConfig.families.eval).toBe("mock");
    expect(agenticConfig.localMock.enabled).toBe(true);
    expect(agenticConfig.targets.some((t) => t.id === agenticConfig.mockTarget)).toBe(true);
  });

  it("copies the whole bundled mock, minus its own tests and databases", () => {
    expect(existsSync(path.join(out, "mock/generator.py"))).toBe(true);
    expect(existsSync(path.join(out, "mock/requirements.txt"))).toBe(true);
    expect(existsSync(path.join(out, "mock/tests"))).toBe(false);
    expect(existsSync(path.join(out, "mock/cupel-mock.sqlite"))).toBe(false);
  });
});

describe("a persona B generation", () => {
  let out;
  beforeAll(() => {
    out = mkdtempSync(path.join(tmpdir(), "cupel-wedge-"));
    generate({
      outDir: out,
      product: { name: "wedge", label: "Wedge", trees: { one: "agent", many: "agents" } },
      answers: Object.fromEntries(FAMILIES.map((f) => [f, f === "chat" ? "mine" : "mock"])),
      agentEndpoint: { url: "http://localhost:9000/chat", stream: "sse" },
      contractVersion: contract.info.version,
    });
  });
  afterAll(() => rmSync(out, { recursive: true, force: true }));

  it("carries the endpoint into the config and the shim that reads it", async () => {
    const { agenticConfig } = await import(pathToFileURL(path.join(out, "agentic.config.ts")).href);
    expect(agenticConfig.agentEndpoint).toEqual({
      url: "http://localhost:9000/chat",
      stream: "sse",
    });
    expect(agenticConfig.families.chat).toBe("mine");
    expect(existsSync(path.join(out, "src/api/bareAgent.ts"))).toBe(true);
  });

  it("tells the adopter in the README where their agent is wired in", () => {
    const readme = readFileSync(path.join(out, "README.md"), "utf8");
    expect(readme).toContain("http://localhost:9000/chat");
    expect(readme).toMatch(/sse streaming/);
  });
});

describe("stream shape detection", () => {
  const headers = (type) => ({ get: () => type });

  it("reads the endpoint's own content-type", async () => {
    expect(await detectStream("http://x", async () => ({ headers: headers("text/event-stream") })))
      .toMatchObject({ stream: "sse" });
    expect(await detectStream("http://x", async () => ({ headers: headers("application/json") })))
      .toMatchObject({ stream: "json" });
  });

  // Their agent may not be running when they generate the folder.
  it("assumes SSE when the endpoint cannot be reached, and says it assumed", async () => {
    const result = await detectStream("http://x", async () => {
      throw new Error("ECONNREFUSED");
    });
    expect(result).toMatchObject({ stream: "sse" });
    expect(result.source).toMatch(/assumed/);
  });
});

describe("backend detection with path rules (item 40)", () => {
  it("finds a nabu-service-shaped backend a plain prefix can't reach", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "cupel-nabu-"));
    const spec = {
      openapi: "3.0.3",
      info: { title: "nabu", version: "1" },
      paths: {
        "/nabu-service/{tree}/chat": { post: { responses: { 200: { description: "ok" } } } },
        "/nabu-service/{tree}/sessions": { get: { responses: { 200: { description: "ok" } } } },
      },
    };
    const specFile = path.join(dir, "openapi.json");
    writeFileSync(specFile, JSON.stringify(spec));
    try {
      const rules = {
        prefix: "nabu-service",
        dropAgenttrees: true,
        renames: [{ from: "conversations", to: "sessions" }],
        splitStream: true,
      };
      const withoutRules = await detectBackend(specFile, contract);
      const withRules = await detectBackend(specFile, contract, rules);
      // a plain prefix alone can't bridge the dropped "agenttrees" segment or
      // the renamed resource — the rules-aware run finds strictly more.
      expect(withRules.init.remapRules).toEqual(rules);
      expect(withRules.report.conformant).toBeGreaterThan(withoutRules.report?.conformant ?? -1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("copyTree", () => {
  it("returns the files it wrote, and writes nothing it was not asked for", () => {
    const out = mkdtempSync(path.join(tmpdir(), "cupel-copy-"));
    try {
      const written = copyTree(process.cwd(), out, ["scripts/dev.mjs", "openapi.yaml"]);
      expect(written.map((f) => f.replace(/\\/g, "/")).sort()).toEqual([
        "openapi.yaml",
        "scripts/dev.mjs",
      ]);
      expect(existsSync(path.join(out, "src"))).toBe(false);
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  });
});

it("answers are exactly mine, mock and hide", () => {
  expect(ANSWERS).toEqual(["mine", "mock", "hide"]);
});
