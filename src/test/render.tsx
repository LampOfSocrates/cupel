import { useCallback, useState, type ReactNode } from "react";
import { render } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { MantineProvider } from "@mantine/core";
import { AppContext } from "../AppContext";
import { mockMe, mockTrees } from "./msw/handlers";

export const testAppState = {
  me: mockMe,
  trees: mockTrees,
  tree: "agent1",
};

// Working refreshConversations, so tests exercise the real sidebar-reload
// signal (AppContext.conversationsVersion).
function TestAppProvider({ children }: { children: ReactNode }) {
  const [conversationsVersion, setConversationsVersion] = useState(0);
  const refreshConversations = useCallback(() => {
    setConversationsVersion((v) => v + 1);
  }, []);
  return (
    <AppContext.Provider
      value={{ ...testAppState, conversationsVersion, refreshConversations }}
    >
      {children}
    </AppContext.Provider>
  );
}

export function renderApp(ui: ReactNode, { route = "/chat" }: { route?: string } = {}) {
  return render(
    <MantineProvider>
      <TestAppProvider>
        <MemoryRouter initialEntries={[route]}>{ui}</MemoryRouter>
      </TestAppProvider>
    </MantineProvider>,
  );
}
