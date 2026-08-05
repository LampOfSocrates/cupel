import { useCallback, useRef, useState, type ReactNode } from "react";
import { render } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { MantineProvider } from "@mantine/core";
import { api } from "../api/client";
import type { Model } from "../api/types";
import { AppContext, type ChatSettings } from "../AppContext";
import { QueueProvider } from "../QueueContext";
import type { AgentTree, Me } from "../api/types";
import { mockMe, mockTrees } from "./msw/handlers";

export const testAppState = {
  me: mockMe,
  trees: mockTrees,
  tree: "agent1",
};

// P2-T07b: boot-state overrides. The admin sections are gated on /me.roles and
// the read-only banner on the active tree's `enabled` — both arrive from the
// boot fetch (App.tsx), so tests inject them here rather than re-booting App.
export interface AppStateOverrides {
  me?: Me;
  trees?: AgentTree[];
}

// Working refreshConversations, so tests exercise the real sidebar-reload
// signal (AppContext.conversationsVersion). Models + chatSettings mirror
// App.tsx: lazy fetch-once GET /models cache and session-scoped settings
// state (P1-T05, feature-spec.md:7).
function TestAppProvider({
  children,
  overrides,
}: {
  children: ReactNode;
  overrides: AppStateOverrides;
}) {
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
        // ?? not spread: an explicitly-passed `undefined` must keep the default.
        me: overrides.me ?? testAppState.me,
        trees: overrides.trees ?? testAppState.trees,
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
// `state` = router location state for the initial entry (P1-T20b: the
// editor → Runs Test-in-Runs handoff travels as navigate state, not a URL).
// `queue` = wrap in QueueProvider (P1-T08) with fast timings — OPT-IN so
// existing tests that count taskStreamRig.clients (RunDetailPage) keep their
// single-subscription arithmetic.
export function renderApp(
  ui: ReactNode,
  {
    route = "/chat",
    state,
    queue = false,
    ...overrides
  }: { route?: string; state?: unknown; queue?: boolean } & AppStateOverrides = {},
) {
  const routed = (
    <MemoryRouter initialEntries={[state === undefined ? route : { pathname: route, state }]}>
      {ui}
    </MemoryRouter>
  );
  return render(
    <MantineProvider env="test">
      <TestAppProvider overrides={overrides}>
        {queue ? (
          <QueueProvider reconnectBaseMs={15} pollMs={40}>
            {routed}
          </QueueProvider>
        ) : (
          routed
        )}
      </TestAppProvider>
    </MantineProvider>,
  );
}
