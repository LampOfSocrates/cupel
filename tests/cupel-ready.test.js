import { describe, it, expect, vi } from "vitest";
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import YAML from "yaml";
import {
  compare,
  PHASE1_PATHS,
  renderReport,
  UNCLASSIFIED,
} from "../scripts/conformance.mjs";
import {
  parseArgs,
  deriveBaseUrl,
  detectPrefix,
  detectAuth,
  buildInit,
  renderInitBlock,
  describeError,
  main,
} from "../scripts/cupel-ready.mjs";

// Comparator unit layer — small fixture specs, no server involved.
// The against-the-real-mock conformance run lives in mock/tests/test_ready.py
// (pytest fetches /openapi.json in-process, then drives the CLI).

const jsonResponse = (schema = {}) => ({
  description: "ok",
  content: { "application/json": { schema } },
});

const doc = (paths) => ({ openapi: "3.0.3", info: { version: "test" }, paths });

// Contract fixture: one GET with a required query param, one POST with a JSON
// body and a response schema that has required keys.
const contract = () =>
  doc({
    "/things/{thingId}": {
      get: {
        parameters: [
          { name: "thingId", in: "path", required: true, schema: { type: "string" } },
          { name: "verbose", in: "query", required: true, schema: { type: "boolean" } },
        ],
        responses: { 200: jsonResponse({ type: "object", required: ["id", "name"] }) },
      },
    },
    "/things": {
      post: {
        requestBody: { required: true, content: { "application/json": { schema: {} } } },
        responses: { 201: jsonResponse() },
      },
    },
  });

// A target that fully conforms (loose response schemas, like FastAPI's).
const conformingTarget = () =>
  doc({
    "/things/{thingId}": {
      get: {
        parameters: [
          { name: "thingId", in: "path", required: true, schema: { type: "string" } },
          { name: "verbose", in: "query", required: true, schema: { type: "boolean" } },
        ],
        responses: { 200: jsonResponse() },
      },
    },
    "/things": {
      post: {
        requestBody: { content: { "application/json": { schema: {} } } },
        responses: { 201: jsonResponse() },
      },
    },
  });

const mutate = (target, fn) => {
  fn(target.paths);
  return target;
};

describe("cupel-ready comparator", () => {
  it("full pass: conformant target → ok, exit-worthy report", () => {
    const report = compare(contract(), conformingTarget());
    expect(report.ok).toBe(true);
    expect(report.checked).toBe(2);
    expect(report.conformant).toBe(2);
    expect(report.missing).toEqual([]);
    expect(report.mismatched).toEqual([]);
  });

  it("missing path is reported as missing", () => {
    const target = mutate(conformingTarget(), (p) => delete p["/things"]);
    const report = compare(contract(), target);
    expect(report.ok).toBe(false);
    expect(report.missing).toEqual([{ method: "POST", path: "/things" }]);
  });

  it("missing method on an existing path is reported as missing", () => {
    const target = mutate(conformingTarget(), (p) => {
      p["/things"] = { get: { responses: { 200: jsonResponse() } } };
    });
    const report = compare(contract(), target);
    expect(report.missing).toEqual([{ method: "POST", path: "/things" }]);
    expect(report.operations.find((o) => o.path === "/things").problems[0]).toMatch(/method not declared/);
  });

  it("missing query param and lost requiredness are mismatches", () => {
    const target = mutate(conformingTarget(), (p) => {
      p["/things/{thingId}"].get.parameters = [
        { name: "thingId", in: "path", required: true, schema: { type: "string" } },
      ];
    });
    expect(compare(contract(), target).mismatched[0].problems).toEqual([
      "param 'verbose' (query) missing",
    ]);

    const optional = mutate(conformingTarget(), (p) => {
      p["/things/{thingId}"].get.parameters[1].required = false;
    });
    expect(compare(contract(), optional).mismatched[0].problems).toEqual([
      "param 'verbose' (query) must be required",
    ]);
  });

  it("disjoint request content types are a mismatch; an undeclared target body is tolerated", () => {
    const disjoint = mutate(conformingTarget(), (p) => {
      p["/things"].post.requestBody = { content: { "application/xml": { schema: {} } } };
    });
    expect(compare(contract(), disjoint).mismatched[0].problems[0]).toMatch(
      /request content types disjoint/,
    );

    // FastAPI handlers that read the raw Request declare no body at all —
    // a loose spec is not a wrong one (docs/readiness.md).
    const undeclared = mutate(conformingTarget(), (p) => delete p["/things"].post.requestBody);
    expect(compare(contract(), undeclared).ok).toBe(true);
  });

  it("primary success code must be declared, with overlapping content types", () => {
    const wrongCode = mutate(conformingTarget(), (p) => {
      p["/things"].post.responses = { 200: jsonResponse() };
    });
    expect(compare(contract(), wrongCode).mismatched[0].problems[0]).toMatch(
      /success response 201 not declared/,
    );

    const wrongContent = mutate(conformingTarget(), (p) => {
      p["/things/{thingId}"].get.responses = {
        200: { description: "ok", content: { "text/html": { schema: {} } } },
      };
    });
    expect(compare(contract(), wrongContent).mismatched[0].problems[0]).toMatch(
      /response 200 content types disjoint/,
    );
  });

  it("shallow schema check: contract-required keys must exist in a declared target schema", () => {
    const partial = mutate(conformingTarget(), (p) => {
      p["/things/{thingId}"].get.responses = {
        200: jsonResponse({ type: "object", properties: { id: { type: "string" } } }),
      };
    });
    expect(compare(contract(), partial).mismatched[0].problems).toEqual([
      "response schema lacks required key(s): name",
    ]);

    // Loose target schema ({}: no properties) skips the check by design.
    expect(compare(contract(), conformingTarget()).ok).toBe(true);
  });

  it("array-of-object responses compare their item shapes", () => {
    const c = doc({
      "/list": {
        get: {
          responses: {
            200: jsonResponse({ type: "array", items: { type: "object", required: ["id"] } }),
          },
        },
      },
    });
    const bad = doc({
      "/list": {
        get: {
          responses: {
            200: jsonResponse({
              type: "array",
              items: { type: "object", properties: { name: {} } },
            }),
          },
        },
      },
    });
    expect(compare(c, bad).mismatched[0].problems).toEqual([
      "response schema lacks required key(s): id",
    ]);
  });

  it("--prefix remaps contract paths before lookup", () => {
    const target = doc({
      "/nabu-service/things/{thingId}": conformingTarget().paths["/things/{thingId}"],
      "/nabu-service/things": conformingTarget().paths["/things"],
    });
    expect(compare(contract(), target).ok).toBe(false);
    const report = compare(contract(), target, { prefix: "/nabu-service" });
    expect(report.ok).toBe(true);
    expect(report.operations[0].targetPath).toBe("/nabu-service/things");
  });

  it("renamed path params match positionally but surface as a param mismatch", () => {
    const target = mutate(conformingTarget(), (p) => {
      p["/things/{thing_id}"] = p["/things/{thingId}"];
      delete p["/things/{thingId}"];
      p["/things/{thing_id}"].get.parameters[0].name = "thing_id";
    });
    const report = compare(contract(), target);
    const row = report.operations.find((o) => o.path === "/things/{thingId}");
    expect(row.status).toBe("mismatch"); // found, not "missing"
    expect(row.targetPath).toBe("/things/{thing_id}");
    expect(row.problems[0]).toMatch(/param 'thingId' \(path\) missing \(target path is/);
  });

  it("phase1Only checks only the Phase-1 surface", () => {
    // Every method of a Phase-1 path counts; a Phase-2 path is skipped whole.
    // Since item 7 stage F4 the split is purely by path — the one Phase-2
    // METHOD that used to sit on a Phase-1 path (the versioned case save) is
    // now POST /eval/cases/{caseId}/versions, a path of its own.
    const c = doc({
      "/me": { get: { responses: { 200: jsonResponse() } } },
      "/auth/token": { post: { responses: { 200: jsonResponse() } } },
      "/eval/cases/{caseId}": { get: { responses: { 200: jsonResponse() } } },
      "/eval/cases/{caseId}/versions": { post: { responses: { 201: jsonResponse() } } },
    });
    const target = doc({
      "/me": { get: { responses: { 200: jsonResponse() } } },
      "/eval/cases/{caseId}": { get: { responses: { 200: jsonResponse() } } },
    });
    const report = compare(c, target, { phase1Only: true });
    expect(report.ok).toBe(true); // /auth/token and the versions POST were not checked
    expect(report.checked).toBe(2);
    expect(compare(c, target).ok).toBe(false);
  });

  it("PHASE1 lists stay in sync with the real contract", () => {
    const real = YAML.parse(readFileSync("openapi.yaml", "utf8"));
    for (const p of PHASE1_PATHS) {
      expect(real.paths[p], `${p} must exist in openapi.yaml`).toBeDefined();
    }
  });

  it("human report renders marks, summary and the PASS/FAIL verdict", () => {
    const pass = renderReport(compare(contract(), conformingTarget()), {
      contractLabel: "contract",
      targetLabel: "target",
    });
    expect(pass).toContain("2/2 operations conformant.");
    expect(pass).toContain("conformance: PASS");

    const target = mutate(conformingTarget(), (p) => delete p["/things"]);
    const fail = renderReport(compare(contract(), target), {
      contractLabel: "contract",
      targetLabel: "target",
    });
    expect(fail).toContain("missing (1): POST /things");
    expect(fail).toContain("conformance: FAIL");
  });

  // Families come from the contract's own `tags` — the comparator holds no
  // list of its own, so these tests declare families on the FIXTURE and the
  // report must follow it, not the real openapi.yaml.
  describe("by family", () => {
    const tagged = () => {
      const c = contract();
      c.tags = [{ name: "things", description: "things" }, { name: "meta", description: "meta" }];
      c.paths["/things/{thingId}"].get.tags = ["things"];
      c.paths["/things"].post.tags = ["meta"];
      return c;
    };

    it("rolls each family up as full / partial / none, in declared order", () => {
      const target = mutate(conformingTarget(), (p) => delete p["/things"]);
      const report = compare(tagged(), target);
      expect(report.families.map((f) => [f.name, f.status, f.conformant, f.operations])).toEqual([
        ["things", "full", 1, 1],
        ["meta", "none", 0, 1],
      ]);
      expect(report.families[1].missing).toEqual(["POST /things"]);
      expect(renderReport(report, { contractLabel: "c", targetLabel: "t" })).toContain(
        "meta            0/1 none",
      );
    });

    it("an operation with no tag reports as unclassified rather than being dropped", () => {
      const c = tagged();
      delete c.paths["/things"].post.tags;
      const report = compare(c, conformingTarget());
      expect(report.families.map((f) => f.name)).toEqual(["things", UNCLASSIFIED]);
      // Nothing is lost: the family rollup covers every checked operation.
      expect(report.families.reduce((n, f) => n + f.operations, 0)).toBe(report.checked);
    });

    it("a target spec with no tags simply has no families (the report degrades, not guesses)", () => {
      const report = compare(contract(), conformingTarget());
      expect(report.families.map((f) => f.name)).toEqual([UNCLASSIFIED]);
      expect(renderReport(report, { contractLabel: "c", targetLabel: "t" })).toContain(
        "2/2 operations conformant.",
      );
    });
  });
});

// Config-from-swagger: derive an agentic.config.ts target block.
describe("cupel-ready --init", () => {
  // Nabu-style fixture: most routes live under
  // /nabu-service, /healthz matches without any remap.
  const nabuContract = () =>
    doc({
      "/healthz": { get: { responses: { 200: jsonResponse() } } },
      "/agenttrees": { get: { responses: { 200: jsonResponse() } } },
      "/agenttrees/{tree}/chat": { post: { responses: { 200: jsonResponse() } } },
    });
  const nabuTarget = () =>
    doc({
      "/healthz": { get: { responses: { 200: jsonResponse() } } },
      "/nabu-service/agenttrees": { get: { responses: { 200: jsonResponse() } } },
      "/nabu-service/agenttrees/{tree}/chat": { post: { responses: { 200: jsonResponse() } } },
    });

  it("parseArgs: --init/--id/--label; --id without --init is an error", () => {
    const options = parseArgs(["spec.json", "--init", "--id", "mycorp", "--label", "MyCorp API"]);
    expect(options.init).toBe(true);
    expect(options.id).toBe("mycorp");
    expect(options.label).toBe("MyCorp API");
    expect(() => parseArgs(["spec.json", "--id", "mycorp"])).toThrow(/--id\/--label require --init/);
  });

  it("baseUrl precedence: absolute servers[0].url > fetched origin > unknown", () => {
    expect(deriveBaseUrl({ servers: [{ url: "https://api.example.com/" }] }, "spec.json")).toEqual({
      baseUrl: "https://api.example.com",
      baseUrlSource: "servers",
    });
    // relative server URL: fall back to the fetched URL's origin (path stripped)
    expect(deriveBaseUrl({ servers: [{ url: "/api/v1" }] }, "http://localhost:4010/openapi.json")).toEqual({
      baseUrl: "http://localhost:4010",
      baseUrlSource: "fetched-origin",
    });
    expect(deriveBaseUrl({}, "spec.yaml")).toEqual({ baseUrl: "", baseUrlSource: "unknown" });
  });

  it("detects the /nabu-service prefix and reports before/after counts", () => {
    const { init } = buildInit(nabuContract(), nabuTarget(), {
      source: "https://nabu.example.com/openapi.json",
    });
    expect(init.remapPrefix).toBe("/nabu-service");
    // /healthz matches without remap; the other two only with it.
    expect(init.conformance.withoutRemap).toEqual({ conformant: 1, checked: 3 });
    expect(init.conformance.withRemap).toEqual({ conformant: 2, checked: 3 });
    // identity derived from the hostname when no flags are given
    expect(init.id).toBe("nabu");
    expect(init.label).toBe("nabu.example.com");
    const block = renderInitBlock(init);
    expect(block).toContain('remap: (p) => "/nabu-service" + p,');
    expect(block).toContain("// conformance without remap 1/3 -> with /nabu-service remap 2/3");
  });

  it("tied prefix candidates emit no remap plus a note", () => {
    const c = doc({
      "/a/x": { get: { responses: { 200: jsonResponse() } } },
      "/b/y": { get: { responses: { 200: jsonResponse() } } },
    });
    const target = doc({
      "/p1/a/x": { get: { responses: { 200: jsonResponse() } } },
      "/p2/b/y": { get: { responses: { 200: jsonResponse() } } },
    });
    const detection = detectPrefix(c, target);
    expect(detection.prefix).toBeNull();
    expect(detection.note).toMatch(/ambiguous prefix candidates \(\/p1, \/p2\)/);
    const { init } = buildInit(c, target, { source: "spec.json" });
    const block = renderInitBlock(init);
    expect(block).not.toContain("remap:");
    expect(block).toContain("ambiguous prefix candidates");
  });

  it("http bearer scheme → requiresToken with a naming comment", () => {
    const target = nabuTarget();
    target.components = {
      securitySchemes: { bearerAuth: { type: "http", scheme: "bearer" } },
    };
    expect(detectAuth(target)).toEqual({
      requiresToken: true,
      authSchemes: [{ name: "bearerAuth", type: "http", scheme: "bearer" }],
    });
    const { init } = buildInit(nabuContract(), target, { source: "spec.json" });
    expect(renderInitBlock(init)).toContain('requiresToken: true, // securityScheme "bearerAuth" (http bearer)');
  });

  it("apiKey scheme → requiresToken; no schemes → omitted", () => {
    const target = nabuTarget();
    target.components = {
      securitySchemes: { demoKey: { type: "apiKey", in: "header", name: "X-Demo-Token" } },
    };
    const { init } = buildInit(nabuContract(), target, { source: "spec.json" });
    expect(init.requiresToken).toBe(true);
    expect(renderInitBlock(init)).toContain('requiresToken: true, // securityScheme "demoKey" (apiKey)');

    const bare = buildInit(nabuContract(), nabuTarget(), { source: "spec.json" }).init;
    expect(bare.requiresToken).toBe(false);
    expect(renderInitBlock(bare)).not.toContain("requiresToken");
  });

  it("emitted block is plausibly valid TS: balanced delimiters + expected keys", () => {
    const { init } = buildInit(nabuContract(), nabuTarget(), {
      source: "https://nabu.example.com/openapi.json",
      id: "mycorp",
      label: "MyCorp API",
    });
    const block = renderInitBlock(init);
    // cheap syntactic check only (no TS compile step by design)
    const count = (re) => (block.match(re) ?? []).length;
    expect(count(/\{/g)).toBe(count(/\}/g));
    expect(count(/\(/g)).toBe(count(/\)/g));
    for (const key of ['id: "mycorp"', 'label: "MyCorp API"', 'baseUrl: "https://nabu.example.com"', "banner: { label:"]) {
      expect(block).toContain(key);
    }
    expect(block).toContain('banner: { label: "MYCORP API BACKEND" }');
    // the human-owned invariant is stated in the header comment
    expect(block).toContain("never writes agentic.config.ts");
    expect(block.endsWith("},")).toBe(true);
  });

  // item 40: a remap richer than one prefix string (scripts/remap-rules.mjs)
  // replaces the derived comment + `remap:` line wholesale.
  it("remapLines overrides the plain-prefix remap rendering", () => {
    const { init } = buildInit(nabuContract(), nabuTarget(), { source: "spec.json" });
    const block = renderInitBlock(init, {
      remapLines: ["  // conformance 3/3 operations with these path rules", "  remap: (path) => path,"],
    });
    expect(block).toContain("with these path rules");
    expect(block).toContain("remap: (path) => path,");
    expect(block).not.toContain('remap: (p) => "/nabu-service" + p,');
    expect(block).not.toContain("conformance without remap");
  });

  // Regression: a backend that enumerates its agents (/svc/agent1/chat,
  // /svc/agent2/chat) used to score 0/N here — no `{tree}` template for the
  // comparator to match — which is the most misleading answer this tool can
  // give. It now folds the ids and puts the contract in the same shape.
  it("reads an ENUMERATED spec instead of reporting it as entirely missing", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cupel-enum-"));
    const file = join(dir, "openapi.json");
    writeFileSync(
      file,
      JSON.stringify({
        openapi: "3.0.3",
        info: { title: "svc", version: "1" },
        paths: {
          "/svc/agent1/chat": { post: { responses: { 200: jsonResponse() } } },
          "/svc/agent2/chat": { post: { responses: { 200: jsonResponse() } } },
        },
      }),
    );
    const contractFile = join(dir, "contract.yaml");
    writeFileSync(
      contractFile,
      YAML.stringify(doc({ "/agenttrees/{tree}/chat": { post: { tags: ["chat"], responses: { 200: jsonResponse() } } } })),
    );

    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await main([file, "--contract", contractFile, "--json"]);
      const payload = JSON.parse(log.mock.calls.at(-1)[0]);
      expect(payload.conformant).toBe(1);
      expect(payload.folded_agents).toMatchObject({ prefix: "/svc", ids: ["agent1", "agent2"] });
    } finally {
      log.mockRestore();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("--json carries the report plus a structured init object (via main)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cupel-init-"));
    const contractPath = join(dir, "contract.json");
    const targetPath = join(dir, "target.json");
    writeFileSync(contractPath, JSON.stringify(nabuContract()));
    writeFileSync(targetPath, JSON.stringify(nabuTarget()));
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const code = await main([
        targetPath, "--contract", contractPath, "--init", "--json",
        "--id", "mycorp", "--label", "MyCorp API",
      ]);
      expect(code).toBe(1); // with-remap run still misses /healthz
      const payload = JSON.parse(log.mock.calls[0][0]);
      // top-level report is the with-remap run
      expect(payload.prefix).toBe("/nabu-service");
      expect(payload.conformant).toBe(2);
      const { init } = payload;
      expect(init).toMatchObject({
        id: "mycorp",
        label: "MyCorp API",
        baseUrl: "", // local file, no servers → unknown
        baseUrlSource: "unknown",
        requiresToken: false,
        remapPrefix: "/nabu-service",
        remapNote: null,
        conformance: {
          withoutRemap: { conformant: 1, checked: 3 },
          withRemap: { conformant: 2, checked: 3 },
        },
      });
      expect(typeof init.block).toBe("string");
      expect(init.block).toContain('remap: (p) => "/nabu-service" + p,');
    } finally {
      log.mockRestore();
    }
  });
});

// Node's fetch wraps every network failure as TypeError("fetch failed") with
// the real reason on .cause — printing error.message alone made a bad cert,
// a refused connection and a DNS failure all look identical.
describe("cupel-ready error reporting", () => {
  it("describeError walks a .cause chain into readable lines", () => {
    const inner = new Error("self-signed certificate");
    const outer = new Error("fetch failed", { cause: inner });
    expect(describeError(outer)).toBe(
      "fetch failed\n  caused by: self-signed certificate",
    );
  });

  it("describeError handles a plain error with no cause", () => {
    expect(describeError(new Error("plain"))).toBe("plain");
  });

  it("describeError walks a chain more than one level deep", () => {
    const root = new Error("ECONNREFUSED");
    const mid = new Error("connect failed", { cause: root });
    const top = new Error("fetch failed", { cause: mid });
    expect(describeError(top)).toBe(
      "fetch failed\n  caused by: connect failed\n  caused by: ECONNREFUSED",
    );
  });

  it("parseArgs: --insecure", () => {
    expect(parseArgs(["spec.json"]).insecure).toBe(false);
    expect(parseArgs(["spec.json", "--insecure"]).insecure).toBe(true);
  });

  it("main: a load failure prints describeError's output and exits 2", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const code = await main(["/no/such/file/openapi.json"]);
      expect(code).toBe(2);
      const printed = err.mock.calls.map((call) => call.join(" ")).join("\n");
      expect(printed).toContain("cupel-ready:");
      // A plain ENOENT has no .cause — describeError must not choke on that.
      expect(printed).toMatch(/ENOENT|no such file/i);
    } finally {
      err.mockRestore();
    }
  });
});
