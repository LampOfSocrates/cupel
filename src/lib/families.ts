// Family answers — the runtime side of the generator's one question per
// family (mine / mock / hide, agentic.config.ts FamilyAnswer).
//
// Three consumers, and they must agree or the app lies about itself:
//   - src/api/target.ts routes a request to the bundled mock when its family
//     answers `mock`;
//   - the shell hides nav entries and routes whose family answers `hide`;
//   - the chrome names the families the mock is answering.
//
// The family LIST is never written here — it is the contract's tags, derived
// into src/api/families.generated.ts. This file only reads answers about them.
import { agenticConfig, type FamilyAnswer } from "../../agentic.config";
import { FAMILIES, familyOfPath, type Family } from "../api/families.generated";

export type { Family, FamilyAnswer };
export { FAMILIES, familyOfPath };

const ANSWERS: FamilyAnswer[] = ["mine", "mock", "hide"];

const isFamily = (name: string): name is Family => (FAMILIES as readonly string[]).includes(name);

// Config keys the contract does not declare, and values that are not answers,
// are dropped — but never in silence: a typo'd family name would otherwise
// look like it took effect. Computed once; the config is a static module.
const configured: Partial<Record<Family, FamilyAnswer>> = (() => {
  const out: Partial<Record<Family, FamilyAnswer>> = {};
  for (const [name, answer] of Object.entries(agenticConfig.families ?? {})) {
    if (!isFamily(name)) {
      console.warn(`agentic.config.ts families: "${name}" is not a family of this contract — ignored`);
    } else if (!ANSWERS.includes(answer)) {
      console.warn(`agentic.config.ts families.${name}: "${answer}" is not mine/mock/hide — ignored`);
    } else {
      out[name] = answer;
    }
  }
  return out;
})();

/**
 * The answer for a family. Unconfigured families — and requests on paths the
 * contract does not describe (familyOfPath → null) — are `mine`: the default
 * is that your backend serves everything, so a config without a `families`
 * block behaves exactly as it did before there was one.
 */
export function familyAnswer(family: Family | null): FamilyAnswer {
  return (family && configured[family]) ?? "mine";
}

export function answerForPath(path: string): FamilyAnswer {
  return familyAnswer(familyOfPath(path));
}

/** A family whose UI must not render at all. */
export function isHidden(family: Family): boolean {
  return familyAnswer(family) === "hide";
}

/** Families the bundled mock is answering — what the chrome badge names. */
export function mockedFamilies(): Family[] {
  return FAMILIES.filter((family) => familyAnswer(family) === "mock");
}

/** Whether anything at all is served by the mock (badge visibility). */
export function hasMockedFamilies(): boolean {
  return mockedFamilies().length > 0;
}

/** Target id serving the `mock` families — agentic.config.ts mockTarget. */
export function mockTargetId(): string {
  return agenticConfig.mockTarget ?? "mock";
}

// ------------------------------------------------------------------ the doors
// Which family each top-level screen belongs to. `hide` removes BOTH the nav
// entry and the route (App.tsx), the same shape the Inspector's role gate
// already uses: a hand-typed path for a hidden family must not render a screen
// whose every request would go nowhere.
//
// Sub-routes follow their parent: /agents/:id/editor is `agents`, /chat/:id is
// `chat`. routeFamily() takes the first segment, so they need no entries.
const ROUTE_FAMILY: Record<string, Family> = {
  "/chat": "chat",
  // /studio merges FOUR contract families into one screen — "datasets" (cases,
  // benchmarks), "judging" (rubrics), "replay" (evaluations) and "admin"
  // (inspector). This map is one-family-per-route, so it names "datasets" as
  // the representative; the per-TAB answer is STUDIO_TABS below, which
  // routeFamily() consults first. Show/hide for the route and its nav entry
  // goes through isStudioHidden(), which checks the three merged families.
  "/studio": "datasets",
  "/queue": "tasks",
  "/agents": "agents",
  "/trace": "trace",
  "/forks": "replay",
  "/settings": "settings",
};

// ---------------------------------------------------------------- studio tabs
// The tabs are ROUTES (/studio/cases, /studio/evaluations/{id}, …), so this is
// the single list App.tsx builds the route block from, StudioFrame draws the
// tab strip from, and defaultStudioPath() picks a landing tab from. Order is
// tab order.
export interface StudioTab {
  /** Path segment under /studio. */
  segment: string;
  label: string;
  family: Family;
  /** Also needs this role on /me — the Inspector's own gate. */
  role?: "inspect";
}

export const STUDIO_TABS: StudioTab[] = [
  { segment: "cases", label: "Cases", family: "datasets" },
  { segment: "benchmarks", label: "Benchmarks", family: "datasets" },
  { segment: "rubrics", label: "Rubrics", family: "judging" },
  { segment: "evaluations", label: "Evaluations", family: "replay" },
  { segment: "inspector", label: "Inspector", family: "admin", role: "inspect" },
];

export interface StudioGate {
  /** /me.roles includes "inspect" — the role half of the Inspector's gate. */
  inspectorAllowed: boolean;
}

/** The tabs a given viewer actually gets, in tab order. */
export function visibleStudioTabs({ inspectorAllowed }: StudioGate): StudioTab[] {
  return STUDIO_TABS.filter(
    (tab) => !isHidden(tab.family) && (tab.role !== "inspect" || inspectorAllowed),
  );
}

/**
 * Where a bare /studio goes. The first tab this viewer can see — an adopter who
 * hid `datasets` lands on Rubrics rather than on a route that does not exist.
 * Falls back to the app's front door only when no tab survives at all, which
 * also means isStudioHidden() is true and the route is absent, so this can
 * never bounce back into /studio.
 */
export function defaultStudioPath(gate: StudioGate): string {
  const first = visibleStudioTabs(gate)[0];
  return first ? `/studio/${first.segment}` : landingRoute();
}

const STUDIO_TAB_FAMILY: Record<string, Family> = Object.fromEntries(
  STUDIO_TABS.map((tab) => [tab.segment, tab.family]),
);

/** The family a UI path belongs to, or null when it belongs to none. */
export function routeFamily(path: string): Family | null {
  const [, first = "", second = ""] = path.split("/");
  // /studio is five tabs over four families, so the badge must name the family
  // of the TAB on screen — resolving the whole route to "datasets" would have
  // labelled the evaluation grid `datasets` where the old standalone
  // /evaluations/{id} correctly said `replay`.
  if (first === "studio") return STUDIO_TAB_FAMILY[second] ?? ROUTE_FAMILY["/studio"];
  return ROUTE_FAMILY[`/${first}`] ?? null;
}

/** Whether a UI path must not render at all. */
export function isRouteHidden(path: string): boolean {
  const family = routeFamily(path);
  return family !== null && isHidden(family);
}

// The families the Studio MERGE is made of. Deliberately not every family a
// tab belongs to: "admin" is the Inspector's, and the Inspector was a
// role-gated route of its own before the merge — it is not on its own reason
// to keep the Studio door open.
const STUDIO_FAMILIES: Family[] = ["datasets", "judging", "replay"];

/**
 * /studio is visible if ANY of the three families it merges still answers
 * something other than `hide` — routeFamily()/isRouteHidden() model one family
 * per route, which doesn't fit a genuine merge, so this is the one route that
 * bypasses them for its own show/hide decision.
 */
export function isStudioHidden(): boolean {
  return STUDIO_FAMILIES.every(isHidden);
}

/**
 * The family of a UI path IF the bundled mock is what answers it — what the
 * chrome badge names, per screen (shell/MockBadge.tsx). null when the page is
 * the adopter's own backend, which is the normal case.
 */
export function mockedFamilyOfRoute(path: string): Family | null {
  const family = routeFamily(path);
  return family && familyAnswer(family) === "mock" ? family : null;
}

/**
 * Where "/" goes. Normally /chat; when chat is hidden, the first door that is
 * not — an adopter who hid chat lands in the studio instead of on a redirect
 * to a route that does not exist.
 */
export function landingRoute(): string {
  const doors = ["/chat", "/studio", "/agents", "/queue", "/settings"];
  const door =
    doors.find((route) => (route === "/studio" ? !isStudioHidden() : !isRouteHidden(route))) ??
    "/settings";
  // Landing on Studio means landing on a TAB. Bare /studio would only redirect
  // to one, and the app's own landing route should not arrive somewhere it has
  // to bounce out of. No recursion: this branch is reachable only when
  // isStudioHidden() is false, which guarantees defaultStudioPath finds a tab
  // and never falls back here.
  return door === "/studio" ? defaultStudioPath({ inspectorAllowed: false }) : door;
}
