import type { ReactNode } from "react";
import { render } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { MantineProvider } from "@mantine/core";
import { AppContext, type AppState } from "../AppContext";
import { mockMe, mockTrees } from "./msw/handlers";

export const testAppState: AppState = {
  me: mockMe,
  trees: mockTrees,
  tree: "agent1",
};

export function renderApp(ui: ReactNode, { route = "/chat" }: { route?: string } = {}) {
  return render(
    <MantineProvider>
      <AppContext.Provider value={testAppState}>
        <MemoryRouter initialEntries={[route]}>{ui}</MemoryRouter>
      </AppContext.Provider>
    </MantineProvider>,
  );
}
