import reactHooks from "eslint-plugin-react-hooks";
import babelParser from "@babel/eslint-parser";

// Lint-only adoption (TASKS.md #10). Scope: the React Hooks rules and nothing
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
    rules: {
      ...reactHooks.configs.flat["recommended-latest"].rules,
      // OFF, deliberately and temporarily: 20 pre-existing sites across 18
      // files (App, ChatPage ×2, EvalPage ×2, InspectorPage ×2, CasebooksPage,
      // EditorPage, EvaluationPage, SettingsPage, TracePage, CompareView,
      // Composer, ConversationList, ConversationPicker, CollectModal,
      // EvalImportModal, ForkModal, useAsync). Every one is a
      // "you-might-not-need-an-effect" reshape, not a defect the rule caught,
      // and reshaping 18 files is its own task — not #10, which exists to make
      // lint run at all. Turn this back on when that task is filed and done.
      "react-hooks/set-state-in-effect": "off",
    },
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
