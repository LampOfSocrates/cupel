import { useCallback, useRef, useState, type ReactNode } from "react";
import { render } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { MantineProvider } from "@mantine/core";
import { api } from "../api/client";
import type { Model } from "../api/types";
import { AppContext, type ChatSettings } from "../AppContext";
import { mockMe, mockTrees } from "./msw/handlers";

export const testAppState = {
  me: mockMe,
  trees: mockTrees,
  tree: "agent1",
};

// Working refreshConversations, so tests exercise the real sidebar-reload
// signal (AppContext.conversationsVersion). Models + chatSettings mirror
// App.tsx: lazy fetch-once GET /models cache and session-scoped settings
// state (P1-T05, feature-spec.md:7).
function TestAppProvider({ children }: { children: ReactNode }) {
  const [conversationsVersion, setConversationsVersion] = useState(0);
  const refreshConversations = useCallback(() => {
    setConversationsVersion((v) => v + 1);
  }, []);
  const [models, setModels] = useState<Model[] | null>(null);
  const modelsRequested = useRef(false);
  const ensureModels = useCallback(() => {
    if (modelsRequested.current) return;
    modelsRequested.current = true;
    api.models().then(setModels).catch(() => {
      modelsRequested.current = false;
    });
  }, []);
  const [chatSettings, setChatSettings] = useState<ChatSettings>({});
  return (
    <AppContext.Provider
      value={{
        ...testAppState,
        conversationsVersion,
        refreshConversations,
        models,
        ensureModels,
        chatSettings,
        setChatSettings,
      }}
    >
      {children}
    </AppContext.Provider>
  );
}

// env="test": Mantine's test mode (MantineProvider.d.ts:42) skips transitions
// and floating-ui hideDetached — without it, popover dropdowns get inline
// display:none in jsdom (zero layout rects read as "reference hidden") and
// role queries can't see their contents.
export function renderApp(ui: ReactNode, { route = "/chat" }: { route?: string } = {}) {
  return render(
    <MantineProvider env="test">
      <TestAppProvider>
        <MemoryRouter initialEntries={[route]}>{ui}</MemoryRouter>
      </TestAppProvider>
    </MantineProvider>,
  );
}
