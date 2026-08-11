import reactHooks from "eslint-plugin-react-hooks";
import babelParser from "@babel/eslint-parser";

// Lint-only adoption. Scope: the React Hooks rules and nothing
// else — no style ruleset, no type-aware linting, and NO React Compiler (that
// one would put a Babel *transform* back into a Vite/rolldown build).
//
// Parser: @babel/eslint-parser in parse-only mode (`requireConfigFile: false`,
// no babel config, no presets, nothing transformed — ESLint asks it for an AST
// and that is all). Not @typescript-eslint/parser: this repo is on TypeScript 7
// (the native compiler), whose npm package no longer exposes the JS compiler
// API typescript-estree needs — `Object.keys(require("typescript"))` is 2 keys
// — and the parser's peer range is `typescript >=4.8.4 <6.1.0`, so installing
// it here is an ERESOLVE conflict *and* would crash if forced. Not hermes-eslint
// either: it hardcodes `flow: 'all'` and chokes on `!` and `satisfies`.
// @babel/core is already in the tree — eslint-plugin-react-hooks depends on it.
// The hook rules are syntactic; none of them need type information.
export default [
  {
    ignores: [
      "dist/**",
      "node_modules/**",
      "playwright-report/**",
      "blob-report/**",
      "test-results/**",
      "coverage/**",
      "mock/**",
      "sketches/**",
    ],
  },
  {
    ...reactHooks.configs.flat["recommended-latest"],
    files: ["src/**/*.{ts,tsx}"],
    // No rule overrides: `recommended-latest` is taken whole, including
    // set-state-in-effect. It was globally off when lint first landed (21 sites
    // across 18 files, deferred as their own task). Twelve of those were
    // reshaped away — derived during render, or reset by remounting a keyed
    // child — and the nine that remain are external-system seams carrying an
    // individual eslint-disable-next-line with the reason at the site.
  },
  {
    files: ["src/**/*.{ts,tsx}"],
    languageOptions: {
      parser: babelParser,
      parserOptions: {
        requireConfigFile: false,
        babelOptions: { parserOpts: { plugins: ["typescript", "jsx"] } },
      },
    },
  },
];
