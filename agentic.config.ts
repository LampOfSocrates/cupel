// agentic.config.ts — THE one config artifact (CLAUDE.md invariant; cupel-phases.md:73
// "Point Cupel at your own backend by editing one file (agentic.config.ts)").
//
// This is the file YOU hand-edit to point Cupel at your backends. Everything
// the app needs to know about where its API lives is declared here; no other
// file in src/ contains a host. The runtime store (src/api/target.ts) picks
// the active target from this list, persists your choice device-locally, and
// every API call — JSON, SSE streams, uploads — is built from it
// (src/api/client.ts).
//
// NOTE on upload limits: the max upload size is enforced SERVER-side (the
// mock's mock/config.py MAX_UPLOAD_BYTES, 5 MiB; openapi.yaml:533-536 — 413
// carries the message the UI surfaces). There is no client-side limit to
// edit here.

/**
 * Product identity — the block an adopter puts their own name into.
 * `npm run init` (scripts/init.mjs) writes it; every UI string that names the
 * product or its agent trees reads it back through src/lib/product.ts, so
 * changing it here changes the app chrome, the login screen, the browser tab
 * title, the instruction export header and the `npm start` banner.
 */
export interface ProductConfig {
  /** Machine name — lowercase, no spaces. */
  name: string;
  /** Human label — the name rendered wherever the product names itself. */
  label: string;
  /**
   * What THIS deployment calls an agent tree ("workspace", "assistant", …).
   * Write both forms the way they read MID-SENTENCE: the UI only ever
   * upper-cases the first character for sentence-initial use and never
   * lower-cases it, so a term that is genuinely a proper noun survives.
   * Omit the block entirely for the default "agent tree" / "agent trees".
   */
  trees?: { one: string; many: string };
}

/** One backend the app can talk to. Add yours to `targets` below. */
export interface BackendTarget {
  /** Stable identifier — persisted in localStorage when selected. */
  id: string;
  /** Human label — shown in the switcher UI and the non-prod chrome banner. */
  label: string;
  /**
   * API origin, e.g. "http://localhost:8000". Empty string "" means
   * SAME-ORIGIN: calls stay relative to the page URL. That is how the
   * production Docker image works — FastAPI serves both the API and the
   * built frontend from one origin (P1-TDEPLOY, docs/deployment.md).
   */
  baseUrl: string;
  /**
   * The target needs an auth token before it will answer (feature-spec.md:157
   * "Prod requires an auth token field"). The token UI ships with the
   * Settings → Backend switcher (P2-T17); the flag is declared here so the
   * switcher knows to ask.
   */
  requiresToken?: boolean;
  /**
   * Chrome banner for this target (feature-spec.md:157 "Non-prod targets show
   * a colored banner in the app chrome so nobody mistakes mock data for
   * real"). `false` = no banner (prod). When UNSET the app falls back to the
   * P2-CONFIG id-based rule: every target except id "prod" shows an orange
   * "<label> backend" banner. color is any CSS color; defaults to orange.
   */
  banner?: { label: string; color?: string } | false;
  /**
   * Route remapping for backends whose routes are NAMED DIFFERENTLY
   * (cupel-phases.md:75 — e.g. everything lives under "/nabu-service/…").
   * Receives the contract path ("/agenttrees/agent1/chat") and returns the
   * path your backend expects. Applied by the client before prefixing
   * baseUrl. Example:
   *   remap: (path) => `/nabu-service${path}`,
   */
  remap?: (path: string) => string;
  /**
   * Escape hatch for backends that don't speak the contract at all
   * (cupel-phases.md:75 "any backend at all via a small adapter module —
   * with the mock filling in whatever your backend doesn't do yet").
   * Module specifier of an adapter, resolved by the switcher/readiness
   * tooling (P2-T17 / P2-READY). Declared + typed now; not consumed yet.
   */
  adapter?: string;
}

/**
 * The BUNDLED DEMO BACKEND — the FastAPI mock in `mock/` (P2-DEVSTART).
 *
 * `npm start` reads this block (scripts/dev.mjs) and, when `enabled`, boots
 * the mock alongside the Vite dev server and prints what it is and where its
 * data lives. It is a DEMO backend for local development: it keeps
 * everything — conversations, runs, versions, judgments, uploads — in ONE
 * SQLite file on this machine's filesystem (`dbPath`). Nothing is synced
 * anywhere; delete the file and you are back to the seed.
 *
 * WHEN YOU CONNECT CUPEL TO YOUR OWN BACKEND: set `enabled: false` and point
 * `defaultTarget.dev` at your target above. `npm start` then runs the UI
 * only, and YOUR backend holds all persistence — Cupel itself stores nothing
 * server-side (the only client-side state is device-local: the chosen target,
 * an auth token, a BYOK LLM key).
 *
 * NOT ONLY LOCAL: the hosted demo deployment (Render, docs/deployment.md)
 * runs this same mock as its WHOLE backend — there it is the real thing, with
 * its own storage mode. This block configures the local developer copy.
 */
export interface LocalMockConfig {
  /** Boot the bundled demo backend as part of `npm start`. */
  enabled: boolean;
  /** Port it listens on. Must match the target you point the app at. */
  port: number;
  /**
   * SQLite file, relative to the repo root — the mock's entire persistence
   * (passed to the mock as CUPEL_MOCK_DB, mock/config.py:51). Git-ignored.
   */
  dbPath: string;
}

/**
 * Per-column overrides for a comparison variant.
 *
 * NOT APPLIED TODAY — AND NOT SILENTLY IGNORED. The turn re-fire that powers
 * chat compare carries `endpoints[]` (one column each) but a SINGLE shared
 * `config` (openapi.yaml ReplayTurnRequest, contract v0.3.0), so a column
 * cannot carry its own instruction version or model. A set that declares one
 * is REJECTED by the picker, with the reason shown in the UI: a preset must
 * never run a comparison that quietly differs from what it says it runs.
 *
 * It is declared here so the config you write today is the config that works
 * unchanged once `ReplayTurnRequest.configs[]` lands (queued with the contract
 * bump, docs/open-items.md) — at that point the picker applies these instead
 * of rejecting them, and no existing `compareSets` entry has to be rewritten.
 * Vary version/model across many conversations in Evaluate meanwhile.
 */
export interface CompareVariantConfig {
  instruction_version?: number;
  snapshot_id?: string;
  model?: string;
  temperature?: number;
}

/** One column of a comparison preset. */
export interface CompareVariantSpec {
  /**
   * The deploy endpoint this column runs against — its id
   * ("ep_agent1_prod") or its name ("prod", case-insensitive) as listed by
   * GET /agenttrees/{tree}/endpoints. Prefer the NAME: endpoint ids are
   * tree-scoped, so a name keeps one preset usable on every tree that
   * deploys to a target of that name.
   */
  endpoint: string;
  /** See CompareVariantConfig — declared, validated, not applied yet. */
  config?: CompareVariantConfig;
}

/**
 * A named A/B comparison — "a team's usual A/B is one click and not a
 * five-field form each time" (docs/plan-ab-compare.md §3). Config supplies
 * the PRESETS; chat compare still allows an ad-hoc endpoint selection, and
 * this stays the only source of truth for the saved ones.
 *
 * Chat compare renders at most 3 columns and the baseline reply — what the
 * live configuration answers — is always column 1, so a set carries at most
 * TWO variants. A longer set is refused outright and named in the UI; it is
 * never trimmed to fit, because a silently shortened comparison is a wrong
 * comparison. Compare more than three at once in Evaluate.
 */
export interface CompareSet {
  /** Stable identifier, unique across sets. */
  id: string;
  /** Human label — the picker's option text. */
  label: string;
  /**
   * Restrict the preset to these agent trees. Omit to offer it on every tree
   * that deploys to the endpoints it names.
   */
  trees?: string[];
  /** The columns. A bare string is shorthand for `{ endpoint: "…" }`. */
  variants: Array<string | CompareVariantSpec>;
}

/**
 * What a family of the contract is wired to.
 *
 * A family is a top-level tag of openapi.yaml (chat, conversations, agents,
 * eval, …) — the unit an adopter answers on, one question each, rather than
 * once per operation (docs/plan-adopter-onboarding.md).
 *
 * - `mine` — your backend serves it, through the active target above.
 * - `mock` — the bundled demo backend serves it, and the app SAYS SO in the
 *   chrome. This is how a half-built backend still gets you a whole UI.
 * - `hide` — the UI for that family is not rendered at all: no nav entry, no
 *   route. What makes the app feel like your product rather than ours with
 *   holes in it.
 */
export type FamilyAnswer = "mine" | "mock" | "hide";

export interface AgenticConfig {
  /** Product identity — name for code/config, label for chrome/branding. */
  product: ProductConfig;
  /** Every backend the app can be pointed at. Edit/extend freely. */
  targets: BackendTarget[];
  /**
   * Which target the app boots on when the device has no stored choice:
   * dev server / tests use `dev`; `vite build` bundles use `production`
   * (preserving src/api/base.ts's original PROD-flag semantic).
   */
  defaultTarget: { dev: string; production: string };
  /** The bundled demo backend `npm start` boots — see LocalMockConfig. */
  localMock: LocalMockConfig;
  /**
   * Per-family wiring — see FamilyAnswer. Keys are the contract's own tags
   * (openapi.yaml `tags`, listed in src/api/families.generated.ts); no list is
   * restated here, and an unknown key is ignored with a warning rather than
   * silently changing what is served. OMIT THE BLOCK for the default: every
   * family is `mine`, which is this repo pointed at a conformant backend.
   *
   * `npm run create` writes it from the adopter's answers.
   */
  families?: Record<string, FamilyAnswer>;
  /**
   * Which target serves the `mock` families — the bundled demo backend, by
   * target id (default "mock"). Only read when some family answers `mock`.
   */
  mockTarget?: string;
  /** Saved A/B comparisons offered by chat compare mode — see CompareSet. */
  compareSets?: CompareSet[];
}

export const agenticConfig: AgenticConfig = {
  product: {
    name: "cupel",
    label: "Cupel",
    trees: { one: "agent tree", many: "agent trees" },
  },

  targets: [
    {
      // The bundled mock — `npm run mock` (FastAPI on :4010). Seeded,
      // stateful, SSE-capable; the target every test rig runs against.
      id: "mock",
      label: "Mock",
      baseUrl: "http://localhost:4010",
      banner: { label: "MOCK BACKEND", color: "#e8590c" },
    },
    {
      // YOUR backend on your dev machine — edit the port to taste.
      id: "local",
      label: "Local",
      baseUrl: "http://localhost:8000",
    },
    {
      // YOUR staging deployment — replace with a real host.
      id: "staging",
      label: "Staging",
      baseUrl: "https://staging.example.com",
      banner: { label: "STAGING BACKEND", color: "#1971c2" },
    },
    {
      // "" = same-origin (see BackendTarget.baseUrl): the deployed app calls
      // the origin that served it. Do not change this unless prod's API
      // lives on a different host than the frontend.
      id: "prod",
      label: "Prod",
      baseUrl: "",
      requiresToken: true,
      banner: false,
    },
  ],

  defaultTarget: { dev: "mock", production: "prod" },

  // Bundled demo backend for local development — see LocalMockConfig above.
  // Using your own backend? enabled: false + defaultTarget.dev = your target.
  localMock: {
    enabled: true,
    port: 4010,
    dbPath: "mock/cupel-mock.sqlite",
  },

  // Your team's usual A/B comparisons, offered in chat compare mode — see
  // CompareSet above. Endpoints are matched by name first, so these work on
  // any tree that deploys to a "prod" / "staging" / "canary" target.
  compareSets: [
    { id: "prod-vs-staging", label: "Prod vs staging", variants: ["prod", "staging"] },
    { id: "vs-staging", label: "Live vs staging", variants: ["staging"] },
  ],
};
