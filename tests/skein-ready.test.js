import { describe, it, expect, vi } from "vitest";
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import YAML from "yaml";
import { compare, PHASE1_PATHS, PHASE1_METHODS, renderReport } from "../scripts/conformance.mjs";
import {
  parseArgs,
  deriveBaseUrl,
  detectPrefix,
  detectAuth,
  buildInit,
  renderInitBlock,
  main,
} from "../scripts/skein-ready.mjs";

// P2-READY comparator unit layer — small fixture specs, no server involved.
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

describe("skein-ready comparator", () => {
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

  it("--prefix remaps contract paths before lookup (skein-phases.md:75)", () => {
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

  it("phase1Only checks only the Phase-1 surface, per operation", () => {
    const c = doc({
      "/me": { get: { responses: { 200: jsonResponse() } } },
      "/auth/token": { post: { responses: { 200: jsonResponse() } } },
      "/eval/cases/{caseId}": {
        get: { responses: { 200: jsonResponse() } },
        put: { responses: { 201: jsonResponse() } }, // Phase-2 method on a Phase-1 path
      },
    });
    const target = doc({
      "/me": { get: { responses: { 200: jsonResponse() } } },
      "/eval/cases/{caseId}": { get: { responses: { 200: jsonResponse() } } },
    });
    const report = compare(c, target, { phase1Only: true });
    expect(report.ok).toBe(true); // /auth/token and the PUT were not checked
    expect(report.checked).toBe(2);
    expect(compare(c, target).ok).toBe(false);
  });

  it("PHASE1 lists stay in sync with the real contract", () => {
    const real = YAML.parse(readFileSync("openapi.yaml", "utf8"));
    for (const p of PHASE1_PATHS) {
      expect(real.paths[p], `${p} must exist in openapi.yaml`).toBeDefined();
    }
    for (const [p, methods] of Object.entries(PHASE1_METHODS)) {
      expect(PHASE1_PATHS).toContain(p);
      for (const m of methods) expect(real.paths[p][m], `${m} ${p}`).toBeDefined();
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
});

// P2-INIT — config-from-swagger: derive an agentic.config.ts target block.
describe("skein-ready --init", () => {
  // Nabu-style fixture (skein-phases.md:75): most routes live under
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

  it("--json carries the report plus a structured init object (via main)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "skein-init-"));
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
