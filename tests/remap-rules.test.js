import { describe, it, expect } from "vitest";
import {
  buildInitFromRules,
  buildRemapFn,
  remapContract,
  renderRemapField,
  renderRemapSource,
  rulesAreEmpty,
} from "../scripts/remap-rules.mjs";

// item 40: a plain prefix (cupel-ready.mjs detectPrefix) covers only one real
// adopter shape. The fixtures below are the exact shape a user described:
//   /nabu-service/agent1/chat        /nabu-service/agent2/chat
//   /nabu-service/agent1/stream      /nabu-service/agent2/stream  (chat's OWN route)
//   /nabu-service/agent1/sessions    /nabu-service/agent2/sessions (not "conversations")
// — no literal "agenttrees" segment anywhere.

const jsonResponse = () => ({ description: "ok", content: { "application/json": { schema: {} } } });
const doc = (paths) => ({ openapi: "3.0.3", info: { version: "test" }, paths });

const contract = () =>
  doc({
    "/healthz": { get: { tags: ["meta"], responses: { 200: jsonResponse() } } },
    "/agenttrees/{tree}/chat": { post: { tags: ["chat"], responses: { 200: jsonResponse() } } },
    "/agenttrees/{tree}/conversations": { get: { tags: ["conversations"], responses: { 200: jsonResponse() } } },
  });

// The prefix applies to EVERY route, not just tree-scoped ones — "everything
// lives under /nabu-service" is the same convention the plain-prefix remap
// already uses (agentic.config.ts's `remap` doc comment).
const nabuTarget = () =>
  doc({
    "/nabu-service/healthz": { get: { responses: { 200: jsonResponse() } } },
    "/nabu-service/{tree}/chat": { post: { responses: { 200: jsonResponse() } } },
    "/nabu-service/{tree}/sessions": { get: { responses: { 200: jsonResponse() } } },
  });

const rules = () => ({
  prefix: "nabu-service",
  dropAgenttrees: true,
  renames: [{ from: "conversations", to: "sessions" }],
  splitStream: true,
  streamSuffix: "stream",
});

describe("rulesAreEmpty", () => {
  it("is true for every default and false as soon as one rule is set", () => {
    expect(rulesAreEmpty({})).toBe(true);
    expect(rulesAreEmpty({ prefix: "", dropAgenttrees: false, renames: [], splitStream: false })).toBe(true);
    expect(rulesAreEmpty({ prefix: "nabu-service" })).toBe(false);
    expect(rulesAreEmpty({ dropAgenttrees: true })).toBe(false);
    expect(rulesAreEmpty({ renames: [{ from: "conversations", to: "sessions" }] })).toBe(false);
    expect(rulesAreEmpty({ renames: [{ from: "" }] })).toBe(true); // a blank row doesn't count
    expect(rulesAreEmpty({ splitStream: true })).toBe(false);
  });
});

describe("buildRemapFn — the live transform", () => {
  it("composes prefix + drop-agenttrees + a rename on a real request path", () => {
    const fn = buildRemapFn(rules());
    expect(fn("/agenttrees/agent1/conversations")).toBe("/nabu-service/agent1/sessions");
    expect(fn("/healthz")).toBe("/nabu-service/healthz"); // prefix still applies with no agenttrees segment
  });

  it("routes chat to the split-stream route only when opts.stream is true", () => {
    const fn = buildRemapFn(rules());
    expect(fn("/agenttrees/agent2/chat", { stream: true })).toBe("/nabu-service/agent2/stream");
    expect(fn("/agenttrees/agent2/chat", { stream: false })).toBe("/nabu-service/agent2/chat");
    expect(fn("/agenttrees/agent2/chat")).toBe("/nabu-service/agent2/chat");
  });

  it("with no rules at all, is the identity function", () => {
    expect(buildRemapFn({})("/me")).toBe("/me");
  });

  it("prefix alone matches today's plain-prefix behavior", () => {
    expect(buildRemapFn({ prefix: "nabu-service" })("/agenttrees/agent1/chat")).toBe(
      "/nabu-service/agenttrees/agent1/chat",
    );
  });
});

describe("renderRemapSource — the written text agrees with the live function", () => {
  it("evaluates to a function behaving exactly like buildRemapFn for the same rules", () => {
    const live = buildRemapFn(rules());
    const written = new Function(`return ${renderRemapSource(rules())}`)();
    const samples = [
      ["/agenttrees/agent1/conversations", undefined],
      ["/healthz", undefined],
      ["/agenttrees/agent2/chat", { stream: true }],
      ["/agenttrees/agent2/chat", { stream: false }],
      ["/agenttrees/agent2/chat", undefined],
    ];
    for (const [path, opts] of samples) {
      expect(written(path, opts)).toBe(live(path, opts));
    }
  });

  it("renders a one-line prefix-only remap, matching the legacy shape", () => {
    expect(renderRemapSource({ prefix: "nabu-service" })).toBe('(path) => "/nabu-service" + path');
  });

  it("renders the identity prefix as an empty string, not undefined", () => {
    expect(renderRemapSource({})).toBe('(path) => "" + path');
  });
});

describe("renderRemapField", () => {
  it("wraps the source as an indented `remap:` object field", () => {
    const field = renderRemapField(rules());
    expect(field.startsWith("  remap: (path, opts) => {")).toBe(true);
    expect(field.endsWith("  },")).toBe(true);
    // every continuation line stays inside the 2-space object-literal indent
    for (const line of field.split("\n").slice(1, -1)) {
      expect(line.startsWith("  ")).toBe(true);
    }
  });
});

describe("remapContract", () => {
  it("transforms contract path TEMPLATES the same way a real path would be", () => {
    const remapped = remapContract(contract(), rules());
    expect(Object.keys(remapped.paths).sort()).toEqual(
      ["/nabu-service/healthz", "/nabu-service/{tree}/chat", "/nabu-service/{tree}/sessions"].sort(),
    );
    // operations (and their tags) travel with the renamed key, untouched
    expect(remapped.paths["/nabu-service/{tree}/sessions"].get.tags).toEqual(["conversations"]);
  });

  it("is a no-op (same object) when the rules are empty", () => {
    const original = contract();
    expect(remapContract(original, {})).toBe(original);
  });
});

describe("buildInitFromRules", () => {
  it("reports conformance against the ADOPTER's real shape, which a plain prefix can't reach", () => {
    const { init, effective } = buildInitFromRules(contract(), nabuTarget(), {
      source: "https://nabu.example.com/openapi.json",
      rules: rules(),
    });
    expect(effective.conformant).toBe(3);
    expect(effective.checked).toBe(3);
    expect(init.conformance.withRemap).toEqual({ conformant: 3, checked: 3 });
    expect(init.remapRules).toEqual(rules());
    expect(init.id).toBe("nabu");
    // per-family rollup still works — renamed paths keep their contract tag
    const chat = effective.families.find((f) => f.name === "chat");
    const conversations = effective.families.find((f) => f.name === "conversations");
    expect(chat.status).toBe("full");
    expect(conversations.status).toBe("full");
  });
});
