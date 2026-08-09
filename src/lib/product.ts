// PW-1 whitelabel-lite — the single place the UI reads its own name from.
// agentic.config.ts `product` is the source (THE one config artifact); no
// component spells "Cupel" or "agent tree" out.
import { agenticConfig, type ProductConfig } from "../../agentic.config";

/** Used when a hand-edited config omits `product.trees` — the shipped wording. */
export const DEFAULT_TREE_TERMS = { one: "agent tree", many: "agent trees" } as const;

/**
 * The four forms every call site needs: mid-sentence and sentence-initial,
 * singular and plural. Sentence-initial only ever UP-cases the first
 * character — down-casing would wreck an adopter whose term is a proper noun
 * ("Skein", "Workspace"), and a config is written mid-sentence-style.
 */
export interface TreeTerms {
  one: string;
  many: string;
  One: string;
  Many: string;
}

export interface ProductLabels {
  label: string;
  tree: TreeTerms;
}

const sentenceInitial = (term: string) => term.charAt(0).toUpperCase() + term.slice(1);

/** Pure resolver — takes a config, applies the defaults, derives the forms. */
export function resolveProductLabels(config: { product?: Partial<ProductConfig> }): ProductLabels {
  const product = config?.product;
  const terms = product?.trees ?? DEFAULT_TREE_TERMS;
  const one = terms.one || DEFAULT_TREE_TERMS.one;
  const many = terms.many || DEFAULT_TREE_TERMS.many;
  return {
    label: product?.label || "Cupel",
    tree: { one, many, One: sentenceInitial(one), Many: sentenceInitial(many) },
  };
}

/** The resolved labels for this checkout. Import this from components. */
export const product = resolveProductLabels(agenticConfig);
