import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

// Two projects (vitest 4 removed environmentMatchGlobs):
// - contract: node env, the OpenAPI suite in tests/
// - ui: jsdom + MSW, component/client tests colocated in src/
export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "contract",
          environment: "node",
          include: ["tests/**/*.test.js"],
        },
      },
      {
        plugins: [react()],
        test: {
          name: "ui",
          environment: "jsdom",
          include: ["src/**/*.test.{ts,tsx}"],
          setupFiles: ["src/test/setup.ts"],
        },
      },
    ],
  },
});
