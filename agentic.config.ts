// agentic.config.ts — THE one config artifact (CLAUDE.md invariant; skein-phases.md:73
// "Point Loom at your own backend by editing one file (agentic.config.ts)").
//
// This is the file YOU hand-edit to point Skein at your backends. Everything
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
   * The target needs an auth token before it will answer (feature-spec.md:161
   * "Prod requires an auth token field"). The token UI ships with the
   * Settings → Backend switcher (P2-T17); the flag is declared here so the
   * switcher knows to ask.
   */
  requiresToken?: boolean;
  /**
   * Chrome banner for this target (feature-spec.md:161 "Non-prod targets show
   * a colored banner in the app chrome so nobody mistakes mock data for
   * real"). `false` = no banner (prod). When UNSET the app falls back to the
   * P2-CONFIG id-based rule: every target except id "prod" shows an orange
   * "<label> backend" banner. color is any CSS color; defaults to orange.
   */
  banner?: { label: string; color?: string } | false;
  /**
   * Route remapping for backends whose routes are NAMED DIFFERENTLY
   * (skein-phases.md:75 — e.g. everything lives under "/nabu-service/…").
   * Receives the contract path ("/agenttrees/agent1/chat") and returns the
   * path your backend expects. Applied by the client before prefixing
   * baseUrl. Example:
   *   remap: (path) => `/nabu-service${path}`,
   */
  remap?: (path: string) => string;
  /**
   * Escape hatch for backends that don't speak the contract at all
   * (skein-phases.md:75 "any backend at all via a small adapter module —
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
 * WHEN YOU CONNECT SKEIN TO YOUR OWN BACKEND: set `enabled: false` and point
 * `defaultTarget.dev` at your target above. `npm start` then runs the UI
 * only, and YOUR backend holds all persistence — Skein itself stores nothing
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
   * (passed to the mock as SKEIN_MOCK_DB, mock/config.py:51). Git-ignored.
   */
  dbPath: string;
}

export interface AgenticConfig {
  /** Product identity — name for code/config, label for chrome/branding. */
  product: { name: string; label: string };
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
}

export const agenticConfig: AgenticConfig = {
  product: { name: "skein", label: "Skein" },

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
    dbPath: "mock/skein-mock.sqlite",
  },
};
