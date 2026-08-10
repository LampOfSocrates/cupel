import "@mantine/core/styles.css";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router";
import { MantineProvider } from "@mantine/core";
import { App } from "./App";

// The production build is served at /cupel-demo/ on the same origin as the
// landing page (mock/root.py mounts it there; vite.config.ts's build-only
// `base` matches). Dev server keeps the app at "/" — import.meta.env.PROD is
// the same static build-time flag src/api/target.ts uses for the same split.
const BASENAME = import.meta.env.PROD ? "/cupel-demo" : "/";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <MantineProvider defaultColorScheme="light">
      <BrowserRouter basename={BASENAME}>
        <App />
      </BrowserRouter>
    </MantineProvider>
  </StrictMode>,
);
