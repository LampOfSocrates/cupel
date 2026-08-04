import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Dev server on :5173 (loom-phases.md:53 "npm run dev # studio on :5173")
export default defineConfig({
  plugins: [react()],
  server: { port: 5173 },
});
