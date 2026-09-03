import "@mantine/core/styles.css";
import "@fontsource-variable/ibm-plex-sans/wght.css";
import "@fontsource/ibm-plex-mono/400.css";
import "@fontsource/ibm-plex-mono/500.css";
import "@fontsource/ibm-plex-mono/600.css";
import "./theme.css";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router";
import { MantineProvider } from "@mantine/core";
import { App } from "./App";
import { theme } from "./theme";

// The production build is served at /cupel-demo/ on the same origin as the
// landing page (mock/root.py mounts it there; vite.config.ts's build-only
// `base` matches). Dev server keeps the app at "/" — import.meta.env.PROD is
// the same static build-time flag src/api/target.ts uses for the same split.
const BASENAME = import.meta.env.PROD ? "/cupel-demo" : "/";

// `npm run dev:msw`: run the whole app against the MSW handlers in a Service
// Worker instead of a backend process — the contract fake the tests use,
// loaded with the demo dataset (src/test/msw/browser.ts). The import is
// DYNAMIC and inside the flag check so the test rig never lands in a build:
// VITE_MSW is statically replaced, so `vite build` sees `if (false)` and drops
// the branch and everything it pulls in.
async function start() {
  if (import.meta.env.VITE_MSW === "1") {
    const { startWorker } = await import("./test/msw/browser");
    await startWorker();
  }

  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <MantineProvider theme={theme} defaultColorScheme="light">
        <BrowserRouter basename={BASENAME}>
          <App />
        </BrowserRouter>
      </MantineProvider>
    </StrictMode>,
  );
}

void start();
