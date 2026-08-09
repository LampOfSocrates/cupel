import type { CompareSet, CompareVariantSpec } from "../../../agentic.config";
import type { Endpoint } from "../../api/types";

// Saved A/B comparisons from agentic.config.ts (the one config artifact) —
// "config supplies the presets; the UI still allows an ad-hoc selection"
// (docs/plan-ab-compare.md §3).
//
// Two rules this module exists to enforce, both of them about not lying to the
// user about what a preset does:
//
//  1. A set that cannot run AS WRITTEN is refused and named, never repaired.
//     Too many variants is not trimmed to fit; an unknown key is not dropped.
//  2. `config` on a variant (instruction version / model / temperature) is a
//     declared field with no effect under contract v0.3.0 — turn re-fire takes
//     `endpoints[]` with ONE shared config — so a set carrying it is refused
//     with that reason rather than run as an endpoints-only comparison.

/** Plan §5.3: "Three is readable on a desktop; beyond that it is a grid." */
export const MAX_COMPARE_COLUMNS = 3;

/** Column 1 is always the baseline reply, so a preset fills the rest. */
export const MAX_COMPARE_VARIANTS = MAX_COMPARE_COLUMNS - 1;

/** A set that will not be offered, and why — rendered verbatim in the UI. */
export interface CompareSetIssue {
  /** The set's `id`, or `#<index>` when the id itself is unusable. */
  id: string;
  reason: string;
}

/** A set that survived validation: endpoint references only, in column order. */
export interface ValidCompareSet {
  id: string;
  label: string;
  trees?: string[];
  /** Endpoint ids or names, exactly as written in the config. */
  endpoints: string[];
}

export interface CompareSetsResult {
  sets: ValidCompareSet[];
  issues: CompareSetIssue[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

// The config is hand-edited, so a shape TypeScript would have caught can still
// reach here (a `as any`, a pasted JSON blob, a `.js` edit of the built file).
// Everything is therefore re-checked at runtime rather than trusted.
function variantEndpoint(variant: unknown): string | { reason: string } {
  if (typeof variant === "string") {
    return nonEmptyString(variant) ? variant : { reason: "has an empty endpoint" };
  }
  if (!isRecord(variant)) {
    return { reason: "has a variant that is neither an endpoint name nor an object" };
  }
  const spec = variant as Partial<CompareVariantSpec> & Record<string, unknown>;
  if (!nonEmptyString(spec.endpoint)) {
    return { reason: "has a variant without an `endpoint`" };
  }
  if (spec.config !== undefined) {
    return {
      reason:
        `sets a per-column config on "${spec.endpoint}" (instruction version / model / ` +
        "temperature). A turn re-fire takes one shared config for every column, so that " +
        "cannot be honoured yet and the set is not offered rather than run as an " +
        "endpoints-only comparison.",
    };
  }
  const unknownKeys = Object.keys(spec).filter((k) => k !== "endpoint" && k !== "config");
  if (unknownKeys.length > 0) {
    return { reason: `has unknown variant key(s): ${unknownKeys.join(", ")}` };
  }
  return spec.endpoint;
}

/**
 * Split the configured sets into the ones chat compare can offer and the ones
 * it refuses. Nothing throws: a broken preset must not take chat down with it,
 * but it must be visible — every rejected set comes back as an issue the
 * picker renders.
 */
export function validateCompareSets(raw: unknown): CompareSetsResult {
  const sets: ValidCompareSet[] = [];
  const issues: CompareSetIssue[] = [];
  if (raw === undefined || raw === null) return { sets, issues };
  if (!Array.isArray(raw)) {
    return { sets, issues: [{ id: "compareSets", reason: "is not an array" }] };
  }

  const seen = new Set<string>();
  raw.forEach((entry, index) => {
    const fallbackId = `#${index + 1}`;
    if (!isRecord(entry)) {
      issues.push({ id: fallbackId, reason: "is not an object" });
      return;
    }
    const set = entry as Partial<CompareSet> & Record<string, unknown>;
    const id = nonEmptyString(set.id) ? set.id : fallbackId;
    if (!nonEmptyString(set.id)) {
      issues.push({ id, reason: "has no `id`" });
      return;
    }
    if (seen.has(id)) {
      issues.push({ id, reason: "repeats an id already used by an earlier set" });
      return;
    }
    seen.add(id);
    if (!nonEmptyString(set.label)) {
      issues.push({ id, reason: "has no `label`" });
      return;
    }
    if (set.trees !== undefined && !(Array.isArray(set.trees) && set.trees.every(nonEmptyString))) {
      issues.push({ id, reason: "has a `trees` that is not a list of tree ids" });
      return;
    }
    if (!Array.isArray(set.variants) || set.variants.length === 0) {
      issues.push({ id, reason: "has no `variants`" });
      return;
    }
    if (set.variants.length > MAX_COMPARE_VARIANTS) {
      issues.push({
        id,
        reason:
          `declares ${set.variants.length} variants. The baseline reply is column 1, so ` +
          `at most ${MAX_COMPARE_VARIANTS} fit in the ${MAX_COMPARE_COLUMNS}-column chat ` +
          "view — split the set, or compare this many at once in Runs.",
      });
      return;
    }

    const endpoints: string[] = [];
    let rejected: string | null = null;
    for (const variant of set.variants) {
      const resolved = variantEndpoint(variant);
      if (typeof resolved !== "string") {
        rejected = resolved.reason;
        break;
      }
      if (endpoints.includes(resolved)) {
        rejected = `names the endpoint "${resolved}" twice`;
        break;
      }
      endpoints.push(resolved);
    }
    if (rejected) {
      issues.push({ id, reason: rejected });
      return;
    }
    sets.push({
      id,
      label: set.label,
      ...(set.trees ? { trees: set.trees as string[] } : {}),
      endpoints,
    });
  });

  return { sets, issues };
}

/** Sets this tree may be offered — the `trees` filter, nothing more. */
export function setsForTree(sets: ValidCompareSet[], tree: string): ValidCompareSet[] {
  return sets.filter((s) => !s.trees || s.trees.includes(tree));
}

/**
 * Turn a set's endpoint references into ids for THIS tree. Id wins over name
 * so an explicit id is never shadowed; names are matched case-insensitively
 * and must be unambiguous — two endpoints sharing a name leaves the reference
 * unresolved rather than picking one.
 */
export function resolveCompareSet(
  set: ValidCompareSet,
  endpoints: Endpoint[],
): { endpointIds: string[]; unresolved: string[] } {
  const endpointIds: string[] = [];
  const unresolved: string[] = [];
  for (const ref of set.endpoints) {
    const byId = endpoints.find((e) => e.id === ref);
    const byName = endpoints.filter((e) => e.name.toLowerCase() === ref.toLowerCase());
    const match = byId ?? (byName.length === 1 ? byName[0] : undefined);
    if (match) endpointIds.push(match.id);
    else unresolved.push(ref);
  }
  return { endpointIds, unresolved };
}
