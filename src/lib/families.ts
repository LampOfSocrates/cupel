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
