// Path-remap rules — the shared primitive behind the browser create-app
// mapper's "path differences" step (docs/TASKS.md item 40). A plain prefix
// (cupel-ready.mjs detectPrefix, "everything lives under /nabu-service/…")
// covers only ONE real adopter shape. Three more showed up as soon as a real
// adopter was described:
//   - the tree id sits directly under the prefix, with no literal
//     "agenttrees" segment ("/nabu-service/agent1/chat", not
//     "/nabu-service/agenttrees/agent1/chat") — `dropAgenttrees`
//   - a resource is named differently ("conversations" -> "sessions") —
//     `renames`
//   - chat streams on its OWN route instead of Cupel's one endpoint + a
//     `stream` body flag ("/agent1/chat" for JSON, "/agent1/stream" for SSE)
//     — `splitStream`, which is why src/api/client.ts buildUrl grew a second
//     argument carrying `{ stream }`
//
// One function expresses all four, and it is used in three places that must
// never drift apart: LIVE, as the request-time `remap` written into
// agentic.config.ts (buildRemapFn / renderRemapSource, same algorithm,
// see remap-rules.test.js for the equivalence check); and at GENERATION
// TIME, to transform the CONTRACT's own path templates before comparing them
// against the adopter's spec (remapContract) — segment renames don't care
// whether "{tree}" is a live id or a template placeholder, so the same
// transform works on both without a second implementation.

import { compare } from "./conformance.mjs";
import { deriveBaseUrl, deriveIdentity, detectAuth } from "./cupel-ready.mjs";

/** @typedef {{prefix?: string, dropAgenttrees?: boolean, renames?: {from: string, to?: string}[], splitStream?: boolean, streamSuffix?: string}} RemapRules */

const defaults = (rules) => ({
  prefix: "",
  dropAgenttrees: false,
  renames: [],
  splitStream: false,
  streamSuffix: "stream",
  ...rules,
});

/** Whether these rules would change anything — an all-default set needs no remap at all. */
export function rulesAreEmpty(rules) {
  const r = defaults(rules);
  return !r.prefix && !r.dropAgenttrees && r.renames.filter((n) => n.from).length === 0 && !r.splitStream;
}

const renameTable = (renames) =>
  Object.fromEntries(renames.filter((r) => r.from).map((r) => [r.from, r.to ?? ""]));

function renameSegments(path, renames) {
  const table = renameTable(renames);
  if (!Object.keys(table).length) return path;
  return path
    .split("/")
    .map((segment) => (segment in table ? table[segment] : segment))
    .join("/");
}

const stripPrefix = (prefix) => prefix.replace(/^\/+|\/+$/g, "");

/**
 * The transform itself — usable both on a real request path (live, with
 * `opts.stream`) and on a contract path TEMPLATE ("/agenttrees/{tree}/chat"),
 * since `{tree}` is just an opaque segment neither dropAgenttrees nor
 * renames ever touch.
 */
export function buildRemapFn(rules) {
  const { prefix, dropAgenttrees, renames, splitStream, streamSuffix } = defaults(rules);
  const prefixPath = prefix ? `/${stripPrefix(prefix)}` : "";
  return (path, opts = {}) => {
    let out = dropAgenttrees ? path.replace(/^\/agenttrees(\/|$)/, "/") : path;
    out = renameSegments(out, renames);
    if (splitStream && opts?.stream && out.endsWith("/chat")) {
      out = out.replace(/\/chat$/, `/${streamSuffix}`);
    }
    return prefixPath + out;
  };
}

/**
 * The SAME transform, as arrow-function SOURCE TEXT for writing into
 * agentic.config.ts. Mirrors buildRemapFn segment-for-segment (a lookup
 * table, not per-rename regexes) so the two never diverge — see
 * remap-rules.test.js.
 */
export function renderRemapSource(rules) {
  const { prefix, dropAgenttrees, renames, splitStream, streamSuffix } = defaults(rules);
  const prefixPath = prefix ? `/${stripPrefix(prefix)}` : "";
  const table = renameTable(renames);
  if (!dropAgenttrees && !Object.keys(table).length && !splitStream) {
    return `(path) => ${JSON.stringify(prefixPath)} + path`;
  }
  const lines = ["(path, opts) => {", "  let out = path;"];
  if (dropAgenttrees) lines.push('  out = out.replace(/^\\/agenttrees(\\/|$)/, "/");');
  if (Object.keys(table).length) {
    lines.push(`  const RENAMES = ${JSON.stringify(table)};`);
    lines.push('  out = out.split("/").map((seg) => (seg in RENAMES ? RENAMES[seg] : seg)).join("/");');
  }
  if (splitStream) {
    lines.push(
      `  if (opts?.stream && out.endsWith("/chat")) out = out.replace(/\\/chat$/, ${JSON.stringify(`/${streamSuffix}`)});`,
    );
  }
  lines.push(`  return ${JSON.stringify(prefixPath)} + out;`);
  lines.push("}");
  return lines.join("\n");
}

/** `renderRemapSource`, wrapped as the full `  remap: (…) => {…},` field text
 * (2-space object-literal indent) — ready to splice into a target block. */
export function renderRemapField(rules) {
  const [first, ...rest] = renderRemapSource(rules).split("\n");
  return [`  remap: ${first}`, ...rest.map((line) => `  ${line}`)].join("\n") + ",";
}

/** contract, with every path key run through the same transform a real
 * request would get (default opts — the non-streaming shape; `splitStream`
 * does not change which family/operation exists, only which route it hits). */
export function remapContract(contract, rules) {
  if (rulesAreEmpty(rules)) return contract;
  const fn = buildRemapFn(rules);
  const paths = {};
  for (const [path, item] of Object.entries(contract.paths ?? {})) paths[fn(path)] = item;
  return { ...contract, paths };
}

// ------------------------------------------------------------- extraction
// Reading the adopter's shape OUT of their OpenAPI document instead of asking
// them to describe it. Their spec already encodes everything the questions
// used to ask for: routes like
//   /nabu-service/agent1/chat   /nabu-service/agent1/stream
//   /nabu-service/agent2/chat   /nabu-service/agent2/sessions
// carry the root prefix, the ids of every agent, the noun those ids are built
// from ("agent"), the fact that chat streams on its own route, and which
// resources are named differently — none of which a human should have to
// restate to a form.

const segmentsOf = (p) => p.split("/").filter(Boolean);
const isParam = (segment) => /^\{.*\}$/.test(segment);
const head = (tail) => tail.split("/")[0];

/**
 * The resource names the contract hangs under a tree — `chat`,
 * `conversations`, `agents`, … Derived, never listed: a renamed or added
 * family changes openapi.yaml and this follows.
 */
export function contractTreeResources(contract) {
  const out = new Set();
  for (const p of Object.keys(contract?.paths ?? {})) {
    const match = /^\/agenttrees\/\{[^}]+\}\/(.+)$/.exec(p);
    if (match) out.add(head(match[1]));
  }
  return out;
}

/** The contract's own name for the tree path parameter (`tree`), read from it. */
export function contractTreeParam(contract) {
  for (const p of Object.keys(contract?.paths ?? {})) {
    const match = /^\/agenttrees\/\{([^}]+)\}\//.exec(p);
    if (match) return match[1];
  }
  return "tree";
}

const stripToWord = (text) => {
  const word = String(text ?? "").replace(/^[^A-Za-z]+/, "").replace(/[^A-Za-z]+$/, "");
  return word.length >= 3 ? word.toLowerCase() : null;
};

const commonPrefix = (values) => {
  if (!values.length) return "";
  let out = values[0];
  for (const value of values.slice(1)) {
    let i = 0;
    while (i < out.length && i < value.length && out[i] === value[i]) i++;
    out = out.slice(0, i);
  }
  return out;
};

const commonSuffix = (values) => {
  const reverse = (s) => [...s].reverse().join("");
  return reverse(commonPrefix(values.map(reverse)));
};

/**
 * The NOUN behind a set of ids — "agent" from ["agent1", "agent2"], "bot"
 * from ["support-bot", "sales-bot"]. This is the answer to "what do you call
 * one of these", taken from the ids themselves rather than from a question.
 * Returns null when the ids share nothing usable, and the caller keeps the
 * shipped default ("agent tree").
 */
export function deriveTreeTerm(ids) {
  const usable = ids.filter((id) => !isParam(id));
  if (usable.length === 0) return null;
  if (usable.length === 1) return stripToWord(usable[0]);
  const candidates = [commonPrefix(usable), commonSuffix(usable)]
    .map(stripToWord)
    .filter(Boolean)
    .sort((a, b) => b.length - a.length);
  return candidates[0] ?? null;
};

/**
 * Where the id slot sits according to the CHAT routes alone: in
 * `/nabu-service/agent1/chat` the `chat` segment is at index 2, so the id is
 * at index 1 and everything before it is the prefix. Most common wins, so one
 * stray `/chat` elsewhere in a big document cannot outvote the real ones.
 *
 * @returns {{depth: number, prefix: string, paths: string[]}|null}
 */
export function chatAnchor(paths) {
  const votes = new Map();
  for (const p of paths) {
    const segments = segmentsOf(p);
    const at = segments.indexOf("chat");
    if (at < 1) continue; // no chat segment, or nothing before it to be an id
    const depth = at - 1;
    const prefix = depth ? `/${segments.slice(0, depth).join("/")}` : "";
    const key = `${depth}|${prefix}`;
    const vote = votes.get(key) ?? { depth, prefix, paths: [] };
    vote.paths.push(p);
    votes.set(key, vote);
  }
  return [...votes.values()].sort((a, b) => b.paths.length - a.paths.length)[0] ?? null;
}

/**
 * Find the path position that holds the agent/tree id, and read the shape
 * around it. Anchored on the adopter's own chat routes (chatAnchor), falling
 * back to scoring by how many of the slot's tail resources the CONTRACT
 * also knows (`chat`, `conversations`, …) — that, not path arithmetic, is
 * what separates "/nabu-service/agent1/chat"'s real id slot (tails: chat,
 * stream, sessions) from treating "nabu-service" as the id (tails:
 * agent1/chat, …, which match nothing).
 *
 * A real adopter's document is mostly NOT about agents — billing, users,
 * reports, webhooks. Those paths score zero (none of their tails is a
 * contract resource) and fall out on their own, so scanning a large spec
 * needs no allow-list. What the caller gets back therefore has to account for
 * the whole document, not just the part that won: `usedPaths` / `ignoredPaths`
 * so the tool can say what it looked past, and `alternatives` so a wrong pick
 * is correctable rather than a dead end.
 *
 * `pick` ({depth, prefix}, from an `alternatives` entry) forces a specific
 * candidate instead of the top-scoring one.
 *
 * @returns null when nothing tree-shaped is found — a spec with no per-agent
 * routes at all is a legitimate answer, not an error to guess around.
 */
export function extractAgentShape(target, contract, { pick = null } = {}) {
  const paths = Object.keys(target?.paths ?? {});
  const known = contractTreeResources(contract);
  const candidates = [];

  for (let depth = 0; depth <= 3; depth++) {
    const byPrefix = new Map();
    for (const p of paths) {
      const segments = segmentsOf(p);
      if (segments.length < depth + 2) continue;
      const prefixSegments = segments.slice(0, depth);
      if (prefixSegments.some(isParam)) continue;
      const prefix = prefixSegments.length ? `/${prefixSegments.join("/")}` : "";
      const slot = byPrefix.get(prefix) ?? new Map();
      const tails = slot.get(segments[depth]) ?? new Set();
      tails.add(segments.slice(depth + 1).join("/"));
      slot.set(segments[depth], tails);
      byPrefix.set(prefix, slot);
    }

    for (const [prefix, slot] of byPrefix) {
      const ids = [...slot.keys()];
      const resources = new Set();
      for (const tails of slot.values()) for (const tail of tails) resources.add(head(tail));
      const matched = [...resources].filter((r) => known.has(r));
      // "stream" is not a contract resource — it is what a split chat route
      // is called — but it is strong evidence this slot is the id slot.
      const streamish = resources.has("stream") && resources.has("chat");
      const score = matched.length + (streamish ? 1 : 0);
      if (score === 0) continue;
      candidates.push({ depth, prefix, ids, resources: [...resources], matched, score });
    }
  }

  candidates.sort(
    (a, b) => b.score - a.score || b.ids.length - a.ids.length || a.depth - b.depth,
  );

  // CHAT IS THE ANCHOR. Every adopter who has any reason to be here has a
  // chat endpoint — it is the wedge and stage 1 of the ladder — so
  // "/…/<something>/chat" points straight at the id slot: the segment before
  // `chat` is an agent, and what sits beside it is the rest of that agent's
  // API. That beats scoring in the two ways that matter on a large document:
  // it is deterministic, and it is explainable in one sentence to someone
  // looking at a 300-endpoint spec. Resource scoring stays as the fallback
  // for a backend whose chat route is called something else entirely.
  const anchor = chatAnchor(paths);
  const anchored = anchor && candidates.find((c) => c.depth === anchor.depth && c.prefix === anchor.prefix);
  const forced = pick && candidates.find((c) => c.depth === pick.depth && c.prefix === pick.prefix);
  const best = forced || anchored || candidates[0];
  if (!best) return null;
  const foundVia = forced ? "your correction" : anchored ? "your chat endpoint" : "matching resource names";

  // Which of the document's paths this pick actually accounts for. The rest
  // are not failures — they are the adopter's other API — but the count is
  // the difference between "understood my spec" and "gave up on most of it".
  const underPick = (p) => {
    const segments = segmentsOf(p);
    const prefixSegments = segmentsOf(best.prefix);
    return (
      segments.length > prefixSegments.length &&
      prefixSegments.every((s, i) => segments[i] === s) &&
      best.ids.includes(segments[prefixSegments.length])
    );
  };
  const usedPaths = paths.filter(underPick);
  const ignoredPaths = paths.filter((p) => !underPick(p));

  // A literal "agenttrees" as the last prefix segment means they DO use the
  // contract's own segment — that belongs in `dropAgenttrees`, not the prefix.
  const prefixSegments = segmentsOf(best.prefix);
  const usesAgenttrees = prefixSegments.at(-1) === "agenttrees";
  const prefix = usesAgenttrees ? `/${prefixSegments.slice(0, -1).join("/")}`.replace(/^\/$/, "") : best.prefix;

  const literalIds = best.ids.filter((id) => !isParam(id));
  const splitStream = best.resources.includes("stream") && best.resources.includes("chat");
  const theirs = best.resources.filter((r) => r !== "stream");
  const unmatchedTheirs = theirs.filter((r) => !known.has(r));
  const unmatchedContract = [...known].filter((r) => !best.resources.includes(r));

  return {
    prefix,
    treeIds: literalIds,
    templated: literalIds.length === 0,
    resources: best.resources.sort(),
    matchedResources: best.matched.sort(),
    // Named differently on their side vs missing on ours — the two halves of
    // a rename. NOT paired automatically: "sessions" could be conversations
    // or something else entirely, and guessing wrong writes a broken remap.
    unmatchedTheirs: unmatchedTheirs.sort(),
    unmatchedContract: unmatchedContract.sort(),
    splitStream,
    treeTerm: deriveTreeTerm(best.ids),
    treeParam: contractTreeParam(contract),
    // The whole document, accounted for. `ignoredPaths` is the adopter's
    // other API, not a problem — but a tool that reads 300 endpoints, uses 6
    // and says nothing about the other 294 reads as one that gave up.
    pathsTotal: paths.length,
    usedPaths: usedPaths.sort(),
    ignoredPaths: ignoredPaths.sort(),
    foundVia,
    chatPaths: (anchor?.paths ?? []).sort(),
    // Where else the id slot could plausibly be, best first. Rendered as
    // one-click corrections: a mispick on an unfamiliar spec should cost a
    // click, not a hand-written remap.
    picked: { depth: best.depth, prefix: best.prefix },
    alternatives: candidates
      .filter((c) => c !== best)
      .slice(0, 3)
      .map((c) => ({
        depth: c.depth,
        prefix: c.prefix,
        ids: c.ids.slice(0, 4),
        idCount: c.ids.length,
        resources: c.resources.sort(),
        score: c.score,
      })),
    rules: {
      prefix,
      dropAgenttrees: !usesAgenttrees,
      renames: [],
      splitStream,
      streamSuffix: "stream",
    },
  };
}

/**
 * Collapse a spec that ENUMERATES its agents back onto one templated path:
 * `/nabu-service/agent1/chat` + `/nabu-service/agent2/chat` both become
 * `/nabu-service/{tree}/chat`.
 *
 * Without this the conformance comparison is silently useless for exactly the
 * adopters this feature exists for. The comparator matches path TEMPLATES
 * (conformance.mjs normalizeTemplate), so the contract's `{tree}` can never
 * match a literal `agent1`, and a backend that implements every operation
 * twice over reports 0/N conformant — which then suggests `mock` for every
 * family. Folding is safe precisely because the ids were identified by
 * sharing the same tails: the collapsed entries are the same shape, so the
 * last one winning loses nothing.
 */
export function foldTreeIds(target, shape) {
  if (!shape?.treeIds?.length) return target;
  const param = shape.treeParam || "tree";
  const prefixSegments = segmentsOf(shape.prefix);
  const paths = {};
  for (const [p, item] of Object.entries(target?.paths ?? {})) {
    const segments = segmentsOf(p);
    const at = prefixSegments.length;
    const underPrefix = prefixSegments.every((s, i) => segments[i] === s);
    if (underPrefix && segments.length > at && shape.treeIds.includes(segments[at])) {
      segments[at] = `{${param}}`;
      // The enumeration IS the parameter: a spec that spells out agent1 and
      // agent2 declares no path param for them, so folding without adding one
      // turns every tree-scoped operation into "param 'tree' missing" — 0/N
      // conformant for a backend that implements the lot. Declared at path
      // level, which is where the comparator merges from.
      const declared = item?.parameters ?? [];
      const already = declared.some((q) => q?.name === param && q?.in === "path");
      paths[`/${segments.join("/")}`] = already
        ? item
        : {
            ...item,
            parameters: [...declared, { name: param, in: "path", required: true, schema: { type: "string" } }],
          };
    } else {
      paths[p] = item;
    }
  }
  return { ...target, paths };
}

/**
 * buildInit()'s shape (scripts/cupel-ready.mjs), but for a RULES-based remap
 * instead of prefix auto-detection: the contract is pre-transformed by the
 * same rules a real request goes through, so the conformance numbers here are
 * what the adopter actually gets once the rules are written into
 * agentic.config.ts — not a guess `cupel-ready --prefix` alone can't express.
 *
 * `shape` (extractAgentShape) folds an enumerated spec's agent ids back onto
 * one `{tree}` template first — see foldTreeIds for why omitting that reports
 * 0/N against a backend that implements everything.
 */
export function buildInitFromRules(contract, target, { source, rules, shape = null, id = null, label = null }) {
  const remapped = remapContract(contract, rules);
  const folded = foldTreeIds(target, shape);
  const base = deriveBaseUrl(target, source);
  const report = compare(remapped, folded, {});
  const init = {
    source,
    ...deriveIdentity(base.baseUrl, { id, label }),
    ...base,
    ...detectAuth(target),
    remapRules: rules,
    remapPrefix: null,
    remapNote: null,
    conformance: { withoutRemap: null, withRemap: { conformant: report.conformant, checked: report.checked } },
  };
  return { init, effective: report };
}
