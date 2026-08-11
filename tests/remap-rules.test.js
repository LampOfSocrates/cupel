import { describe, it, expect } from "vitest";
import {
  buildInitFromRules,
  buildRemapFn,
  chatAnchor,
  contractTreeResources,
  deriveTreeTerm,
  extractAgentShape,
  foldTreeIds,
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
    // carried so the noisy fixture's /v1/orgs/{org}/agents is a REAL decoy —
    // a path whose resource name the contract genuinely knows.
    "/agenttrees/{tree}/agents": { get: { tags: ["agents"], responses: { 200: jsonResponse() } } },
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
      [
        "/nabu-service/healthz",
        "/nabu-service/{tree}/chat",
        "/nabu-service/{tree}/sessions",
        "/nabu-service/{tree}/agents",
      ].sort(),
    );
    // operations (and their tags) travel with the renamed key, untouched
    expect(remapped.paths["/nabu-service/{tree}/sessions"].get.tags).toEqual(["conversations"]);
  });

  it("is a no-op (same object) when the rules are empty", () => {
    const original = contract();
    expect(remapContract(original, {})).toBe(original);
  });
});

// The adopter's spec already says everything the old questions asked for.
// This fixture is the shape the user described verbatim: agents ALWAYS live
// at /XXXX/agent1 and /XXXX/agent2, chat streams on its own route, and their
// "conversations" are called "sessions".
const enumeratedTarget = () =>
  doc({
    "/nabu-service/agent1/chat": { post: { responses: { 200: jsonResponse() } } },
    "/nabu-service/agent1/stream": { post: { responses: { 200: jsonResponse() } } },
    "/nabu-service/agent1/sessions": { get: { responses: { 200: jsonResponse() } } },
    "/nabu-service/agent2/chat": { post: { responses: { 200: jsonResponse() } } },
    "/nabu-service/agent2/stream": { post: { responses: { 200: jsonResponse() } } },
    "/nabu-service/agent2/sessions": { get: { responses: { 200: jsonResponse() } } },
  });

describe("contractTreeResources", () => {
  it("derives the per-tree resource names from the contract, listing none itself", () => {
    expect([...contractTreeResources(contract())].sort()).toEqual(["agents", "chat", "conversations"]);
  });
});

describe("deriveTreeTerm — the noun, taken from the ids", () => {
  it("reads 'agent' out of agent1/agent2 rather than asking", () => {
    expect(deriveTreeTerm(["agent1", "agent2"])).toBe("agent");
  });

  it("falls back to a common suffix when the ids differ at the front", () => {
    expect(deriveTreeTerm(["support-bot", "sales-bot"])).toBe("bot");
  });

  it("uses a lone id as-is, and gives up rather than inventing a word", () => {
    expect(deriveTreeTerm(["assistant"])).toBe("assistant");
    expect(deriveTreeTerm(["a1", "b2"])).toBeNull();
    expect(deriveTreeTerm([])).toBeNull();
    expect(deriveTreeTerm(["{tree}"])).toBeNull();
  });
});

describe("extractAgentShape — reading the shape out of their openapi.json", () => {
  it("finds the prefix, the agent ids, the noun and the split stream route", () => {
    const shape = extractAgentShape(enumeratedTarget(), contract());
    expect(shape.prefix).toBe("/nabu-service");
    expect(shape.treeIds).toEqual(["agent1", "agent2"]);
    expect(shape.treeTerm).toBe("agent");
    expect(shape.splitStream).toBe(true);
    expect(shape.templated).toBe(false);
  });

  it("reports the resources that did not line up, without guessing the pairing", () => {
    const shape = extractAgentShape(enumeratedTarget(), contract());
    expect(shape.matchedResources).toEqual(["chat"]);
    expect(shape.unmatchedTheirs).toEqual(["sessions"]);
    expect(shape.unmatchedContract).toEqual(["agents", "conversations"]);
    // a guessed conversations->sessions rename would silently write a wrong
    // remap, so the rules it hands back carry none
    expect(shape.rules.renames).toEqual([]);
  });

  it("hands back rules that actually reach their routes", () => {
    const shape = extractAgentShape(enumeratedTarget(), contract());
    const fn = buildRemapFn(shape.rules);
    expect(fn("/agenttrees/agent1/chat")).toBe("/nabu-service/agent1/chat");
    expect(fn("/agenttrees/agent2/chat", { stream: true })).toBe("/nabu-service/agent2/stream");
  });

  it("does not mistake the root prefix for the id slot", () => {
    // "nabu-service" is one value in that position too — what separates it
    // from the real id slot is that ITS tails (agent1/chat, …) match no
    // contract resource, while agent1's (chat, …) do.
    const shape = extractAgentShape(enumeratedTarget(), contract());
    expect(shape.treeIds).not.toContain("nabu-service");
  });

  it("handles a templated {tree} slot too, and keeps the contract's own segment", () => {
    const templated = doc({
      "/nabu-service/agenttrees/{tree}/chat": { post: { responses: { 200: jsonResponse() } } },
      "/nabu-service/agenttrees/{tree}/conversations": { get: { responses: { 200: jsonResponse() } } },
    });
    const shape = extractAgentShape(templated, contract());
    expect(shape.templated).toBe(true);
    expect(shape.prefix).toBe("/nabu-service");
    expect(shape.rules.dropAgenttrees).toBe(false);
    expect(buildRemapFn(shape.rules)("/agenttrees/x/chat")).toBe("/nabu-service/agenttrees/x/chat");
  });

  it("returns null for a spec with nothing tree-shaped in it", () => {
    expect(extractAgentShape(doc({ "/healthz": { get: {} } }), contract())).toBeNull();
    expect(extractAgentShape(doc({}), contract())).toBeNull();
  });
});

// A real adopter document is mostly not about agents. These are the paths a
// mid-sized enterprise API carries around the six that matter, including a
// decoy that mentions a contract resource name.
const noisyTarget = () => {
  const paths = {};
  for (const p of [
    "/v1/users", "/v1/users/{userId}", "/v1/orgs/{org}/members", "/v1/orgs/{org}/billing",
    "/v1/reports/{reportId}/export", "/v1/webhooks", "/v1/audit/{eventId}",
    "/v1/tickets/{ticketId}/comments", "/health", "/metrics",
    "/v1/orgs/{org}/agents", // decoy: a contract resource name, not the agent slot
  ]) {
    paths[p] = { get: { responses: { 200: jsonResponse() } } };
  }
  return doc({ ...paths, ...enumeratedTarget().paths });
};

describe("chatAnchor — chat is what points at the agent", () => {
  it("reads the id slot straight off the chat routes", () => {
    expect(chatAnchor(["/nabu-service/agent1/chat", "/nabu-service/agent2/chat"])).toMatchObject({
      depth: 1,
      prefix: "/nabu-service",
    });
  });

  it("handles the contract's own shape and a deeper prefix", () => {
    expect(chatAnchor(["/agenttrees/{tree}/chat"])).toMatchObject({ depth: 1, prefix: "/agenttrees" });
    expect(chatAnchor(["/api/v2/svc/bot7/chat"])).toMatchObject({ depth: 3, prefix: "/api/v2/svc" });
  });

  it("lets the majority win so one stray /chat cannot hijack it", () => {
    const anchor = chatAnchor([
      "/nabu-service/agent1/chat",
      "/nabu-service/agent2/chat",
      "/support/widget/chat",
    ]);
    expect(anchor.prefix).toBe("/nabu-service");
  });

  it("finds nothing when there is no chat segment, or nothing before it", () => {
    expect(chatAnchor(["/v1/users", "/health"])).toBeNull();
    expect(chatAnchor(["/chat"])).toBeNull();
  });
});

describe("focus on a large, mostly-unrelated document", () => {
  it("picks the agent slot out of a noisy spec, via chat", () => {
    const shape = extractAgentShape(noisyTarget(), contract());
    expect(shape.prefix).toBe("/nabu-service");
    expect(shape.treeIds).toEqual(["agent1", "agent2"]);
    expect(shape.foundVia).toBe("your chat endpoint");
  });

  it("accounts for every path in the document, not just the ones it used", () => {
    const shape = extractAgentShape(noisyTarget(), contract());
    expect(shape.pathsTotal).toBe(17);
    expect(shape.usedPaths).toHaveLength(6);
    expect(shape.ignoredPaths).toHaveLength(11);
    expect(shape.usedPaths.length + shape.ignoredPaths.length).toBe(shape.pathsTotal);
    expect(shape.ignoredPaths).toContain("/v1/orgs/{org}/billing");
  });

  it("is not fooled by a decoy path carrying a contract resource name", () => {
    const shape = extractAgentShape(noisyTarget(), contract());
    expect(shape.ignoredPaths).toContain("/v1/orgs/{org}/agents");
  });

  // A mispick on an unfamiliar spec should cost a click, not a hand-written remap.
  it("offers the runner-up slots, and takes a correction", () => {
    const shape = extractAgentShape(noisyTarget(), contract());
    expect(shape.alternatives.length).toBeGreaterThan(0);
    const other = shape.alternatives[0];
    const corrected = extractAgentShape(noisyTarget(), contract(), {
      pick: { depth: other.depth, prefix: other.prefix },
    });
    expect(corrected.prefix).toBe(other.prefix);
    expect(corrected.foundVia).toBe("your correction");
  });

  it("falls back to resource scoring when chat is named something else", () => {
    const noChat = doc({
      "/nabu-service/agent1/conversations": { get: { responses: { 200: jsonResponse() } } },
      "/nabu-service/agent2/conversations": { get: { responses: { 200: jsonResponse() } } },
    });
    const shape = extractAgentShape(noChat, contract());
    expect(shape.foundVia).toBe("matching resource names");
    expect(shape.treeIds).toEqual(["agent1", "agent2"]);
  });
});

describe("foldTreeIds — an enumerated spec still gets a real conformance number", () => {
  it("collapses agent1/agent2 onto one {tree} template", () => {
    const shape = extractAgentShape(enumeratedTarget(), contract());
    const folded = foldTreeIds(enumeratedTarget(), shape);
    expect(Object.keys(folded.paths).sort()).toEqual([
      "/nabu-service/{tree}/chat",
      "/nabu-service/{tree}/sessions",
      "/nabu-service/{tree}/stream",
    ]);
  });

  // The enumeration IS the path parameter. A spec listing agent1 and agent2
  // declares none, so folding alone leaves every operation failing the
  // comparator's "param 'tree' missing" check — 0/N for a working backend.
  it("declares the {tree} path parameter the enumeration stood in for", () => {
    const shape = extractAgentShape(enumeratedTarget(), contract());
    const folded = foldTreeIds(enumeratedTarget(), shape);
    expect(folded.paths["/nabu-service/{tree}/chat"].parameters).toContainEqual({
      name: "tree",
      in: "path",
      required: true,
      schema: { type: "string" },
    });
  });

  it("takes the parameter's name from the contract, not a hardcoded 'tree'", () => {
    const odd = doc({
      "/agenttrees/{treeId}/chat": { post: { tags: ["chat"], responses: { 200: jsonResponse() } } },
    });
    const shape = extractAgentShape(enumeratedTarget(), odd);
    expect(shape.treeParam).toBe("treeId");
    expect(Object.keys(foldTreeIds(enumeratedTarget(), shape))).toBeTruthy();
    expect(foldTreeIds(enumeratedTarget(), shape).paths["/nabu-service/{treeId}/chat"]).toBeDefined();
  });

  it("leaves a templated spec alone", () => {
    const templated = doc({ "/nabu-service/{tree}/chat": { post: { responses: { 200: jsonResponse() } } } });
    expect(foldTreeIds(templated, { treeIds: [], prefix: "/nabu-service" })).toBe(templated);
  });

  // The regression this exists for: the comparator matches path TEMPLATES, so
  // without folding, a backend implementing every operation twice over scores
  // 0/N — and 0/N suggests `mock` for every family, which is the exact
  // opposite of the truth.
  it("is what makes chat conformant at all for the enumerated shape", () => {
    const shape = extractAgentShape(enumeratedTarget(), contract());
    const unfolded = buildInitFromRules(contract(), enumeratedTarget(), {
      source: "spec.json",
      rules: shape.rules,
    });
    const folded = buildInitFromRules(contract(), enumeratedTarget(), {
      source: "spec.json",
      rules: shape.rules,
      shape,
    });
    expect(unfolded.effective.conformant).toBe(0);
    expect(folded.effective.conformant).toBeGreaterThan(0);
    expect(folded.effective.families.find((f) => f.name === "chat").status).toBe("full");
  });
});

describe("buildInitFromRules", () => {
  it("reports conformance against the ADOPTER's real shape, which a plain prefix can't reach", () => {
    const { init, effective } = buildInitFromRules(contract(), nabuTarget(), {
      source: "https://nabu.example.com/openapi.json",
      rules: rules(),
    });
    // 4 contract operations checked; `agents` is the one this target lacks.
    expect(effective.conformant).toBe(3);
    expect(effective.checked).toBe(4);
    expect(init.conformance.withRemap).toEqual({ conformant: 3, checked: 4 });
    expect(init.remapRules).toEqual(rules());
    expect(init.id).toBe("nabu");
    // per-family rollup still works — renamed paths keep their contract tag
    const chat = effective.families.find((f) => f.name === "chat");
    const conversations = effective.families.find((f) => f.name === "conversations");
    expect(chat.status).toBe("full");
    expect(conversations.status).toBe("full");
  });
});
