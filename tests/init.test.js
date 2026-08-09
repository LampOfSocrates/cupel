import { describe, it, expect } from "vitest";
import { readFileSync, existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildInit } from "../scripts/cupel-ready.mjs";
import {
  slugify,
  pluralize,
  specCandidates,
  valueRange,
  arrayElements,
  renderProductBlock,
  applyAnswers,
  writeConfig,
} from "../scripts/init.mjs";

// PW-1 — `npm run init` writes agentic.config.ts. The interactivity is not
// under test; the WRITE is: it edits the one config artifact in place, so a
// checkout's hand-written comments, extra targets and compareSets have to
// survive, and re-running must not leave two targets with the same id.

const SOURCE = readFileSync("agentic.config.ts", "utf8");

const jsonResponse = () => ({ description: "ok", content: { "application/json": { schema: {} } } });
const doc = (paths) => ({ openapi: "3.0.3", info: { version: "test" }, paths });

/** A real init object, derived the way the script derives it (via cupel-ready). */
function initFor(source = "https://nabu.example.com/openapi.json", extra = {}) {
  const contract = doc({ "/agenttrees": { get: { responses: { 200: jsonResponse() } } } });
  const target = doc({
    "/nabu-service/agenttrees": { get: { responses: { 200: jsonResponse() } } },
  });
  target.servers = [{ url: "https://nabu.example.com" }];
  return { ...buildInit(contract, target, { source }).init, ...extra };
}

const answers = (overrides = {}) => ({
  product: {
    name: "nabu",
    label: "Nabu",
    trees: { one: "workspace", many: "workspaces" },
    ...overrides.product,
  },
  init: overrides.init ?? initFor(),
});

describe("answer normalisation", () => {
  it("slugifies a product name into product.name", () => {
    expect(slugify("Nabu Studio")).toBe("nabu-studio");
    expect(slugify("  Acme!! ")).toBe("acme");
    expect(slugify("***")).toBe("app");
  });

  it("suggests a plural (the prompt's default — the user can override it)", () => {
    expect(pluralize("workspace")).toBe("workspaces");
    expect(pluralize("agent mesh")).toBe("agent meshes");
    expect(pluralize("assembly")).toBe("assemblies");
  });

  it("probes /openapi.json then /openapi.yaml, or uses a spec path verbatim", () => {
    expect(specCandidates("http://localhost:8000/")).toEqual([
      "http://localhost:8000/openapi.json",
      "http://localhost:8000/openapi.yaml",
    ]);
    expect(specCandidates("https://x.test/spec.yaml")).toEqual(["https://x.test/spec.yaml"]);
  });
});

describe("scanning the real agentic.config.ts", () => {
  it("finds each top-level value of the exported config", () => {
    const slice = (key) => {
      const { start, end } = valueRange(SOURCE, key);
      return SOURCE.slice(start, end);
    };
    expect(slice("product")).toMatch(/^\{[\s\S]*label: "Cupel"[\s\S]*\}$/);
    expect(slice("targets").startsWith("[")).toBe(true);
    expect(slice("targets").endsWith("]")).toBe(true);
    expect(slice("defaultTarget")).toBe('{ dev: "mock", production: "prod" }');
  });

  it("splits the targets array into its four entries", () => {
    const elements = arrayElements(SOURCE, valueRange(SOURCE, "targets"));
    expect(elements).toHaveLength(4);
    const texts = elements.map((e) => SOURCE.slice(e.start, e.end));
    expect(texts[0]).toContain('id: "mock"');
    expect(texts[0]).toContain("The bundled mock"); // per-entry comments stay inside their entry
    expect(texts[3]).toContain('id: "prod"');
  });

  it("renders a product block with both grammatical forms", () => {
    expect(renderProductBlock(answers().product)).toContain(
      'trees: { one: "workspace", many: "workspaces" },',
    );
  });
});

describe("applyAnswers", () => {
  const written = applyAnswers(SOURCE, answers());

  it("replaces the product block with the adopter's identity", () => {
    expect(written).toContain('label: "Nabu",');
    expect(written).toContain('trees: { one: "workspace", many: "workspaces" },');
    expect(written).not.toContain('label: "Cupel"');
  });

  it("adds the detected target, with the remap and conformance cupel-ready derived", () => {
    expect(written).toContain('id: "nabu",');
    expect(written).toContain('baseUrl: "https://nabu.example.com",');
    expect(written).toContain('remap: (p) => "/nabu-service" + p,');
    expect(written).toContain("Written by `npm run init`");
  });

  it("points defaultTarget.dev at it and leaves production alone", () => {
    expect(written).toContain('defaultTarget: { dev: "nabu", production: "prod" }');
  });

  it("stops booting the bundled demo backend once you have your own", () => {
    const { start, end } = valueRange(written, "localMock");
    expect(written.slice(start, end)).toContain("enabled: false");
  });

  it("keeps the bundled demo backend when the URL IS the bundled demo backend", () => {
    const mock = applyAnswers(
      SOURCE,
      answers({ init: initFor("http://localhost:4010/openapi.json", { isBundledMock: true }) }),
    );
    const { start, end } = valueRange(mock, "localMock");
    expect(mock.slice(start, end)).toContain("enabled: true");
  });

  it("preserves everything the adopter did not ask about", () => {
    expect(written).toContain('id: "prod"');
    expect(written).toContain('id: "staging"');
    expect(written).toContain('{ id: "prod-vs-staging", label: "Prod vs staging"');
    // the file's documentation is the reason this is an edit, not a regeneration
    expect(written).toContain("THE one config artifact");
    expect(written).toContain("export interface BackendTarget");
  });

  it("stays syntactically plausible: balanced delimiters, one agenticConfig", () => {
    const count = (re) => (written.match(re) ?? []).length;
    expect(count(/\{/g)).toBe(count(/\}/g));
    expect(count(/\[/g)).toBe(count(/\]/g));
    expect(count(/export const agenticConfig/g)).toBe(1);
  });

  it("is idempotent — re-running replaces the target instead of duplicating its id", () => {
    const twice = applyAnswers(written, answers());
    expect(arrayElements(twice, valueRange(twice, "targets"))).toHaveLength(5);
    expect((twice.match(/id: "nabu",/g) ?? []).length).toBe(1);
    expect((twice.match(/Written by `npm run init`/g) ?? []).length).toBe(1);
  });
});

describe("writeConfig", () => {
  it("keeps the previous config as .bak and leaves no temp file behind", () => {
    const dir = mkdtempSync(join(tmpdir(), "cupel-init-"));
    const file = join(dir, "agentic.config.ts");
    writeFileSync(file, SOURCE, "utf8");

    writeConfig(file, applyAnswers(SOURCE, answers()));

    expect(readFileSync(file, "utf8")).toContain('label: "Nabu",');
    expect(readFileSync(`${file}.bak`, "utf8")).toBe(SOURCE);
    expect(existsSync(`${file}.tmp`)).toBe(false);
  });
});
