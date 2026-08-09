import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { agenticConfig } from "./agentic.config";

// PW-1 — index.html is static, so the browser tab title cannot import the
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

// Dev server on :5173 (cupel-phases.md:53 "npm run dev # studio on :5173")
export default defineConfig({
  plugins: [react(), productTitle(agenticConfig.product.label)],
  server: { port: 5173 },
});
