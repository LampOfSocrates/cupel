import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { agenticConfig } from "./agentic.config";

// index.html is static, so the browser tab title cannot import the
// config; this substitutes it at serve AND build time (both paths run
// transformIndexHtml), keeping product.label the only place the name lives.
const PRODUCT_LABEL_TOKEN = /%PRODUCT_LABEL%/g;

export function productTitle(label: string): Plugin {
  return {
    name: "product-title",
    transformIndexHtml: {
      order: "pre",
      handler: (html) => html.replace(PRODUCT_LABEL_TOKEN, label),
    },
  };
}

// Dev server on :5173 — `npm run dev` serves the studio there.
// base is BUILD-ONLY (command === "build"): the hosted demo lives at
// /cupel-demo/ on the same origin as the landing page (mock/root.py mounts
// the whole app there), so a production build's emitted asset/script URLs
// need that prefix baked in. `base` also affects the dev server's own root
// path if left unconditional, which would break `npm start` (UI expected at
// http://localhost:5173/, not /cupel-demo/) — so dev keeps the default "/".
export default defineConfig(({ command }) => ({
  plugins: [react(), productTitle(agenticConfig.product.label)],
  base: command === "build" ? "/cupel-demo/" : "/",
  server: { port: 5173 },
}));
