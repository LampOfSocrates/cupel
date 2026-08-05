import { useCallback, useEffect, useRef, useState } from "react";
import { Navigate, Route, Routes } from "react-router";
import { Alert, Center, Loader } from "@mantine/core";
import { api } from "./api/client";
import type { AgentTree, Me, Model } from "./api/types";
import { AppContext, type ChatSettings } from "./AppContext";
import { QueueProvider } from "./QueueContext";
import { Shell } from "./shell/Shell";
import { ChatPage } from "./pages/ChatPage";
import { RunsPage } from "./pages/RunsPage";
import { RunDetailPage } from "./pages/RunDetailPage";
import { QueuePage } from "./pages/QueuePage";
import { AgentsPage } from "./pages/AgentsPage";
import { EditorPage } from "./pages/EditorPage";
import { AgentConversationsPage } from "./pages/AgentConversationsPage";
import { ForkComparePage } from "./pages/ForkComparePage";
import { TracePage } from "./pages/TracePage";

const DEFAULT_TREE = "agent1";

export function App() {
  // Boot: GET /me is always called (invariant, skein-phases.md:160) alongside
  // GET /agenttrees (feature-spec.md:225 "App shell / sidebar | GET /me, GET /agenttrees").
  const [me, setMe] = useState<Me | null>(null);
  const [trees, setTrees] = useState<AgentTree[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [conversationsVersion, setConversationsVersion] = useState(0);
  const refreshConversations = useCallback(() => {
    setConversationsVersion((v) => v + 1);
  }, []);

  // P1-T05: GET /models fetched lazily on first settings-menu open, once per
  // session (feature-spec.md:122). Ref guards a duplicate in-flight fetch;
  // cleared on failure so a later open can retry.
  const [models, setModels] = useState<Model[] | null>(null);
  const modelsRequested = useRef(false);
  const ensureModels = useCallback(() => {
    if (modelsRequested.current) return;
    modelsRequested.current = true;
    api.models().then(setModels).catch(() => {
      modelsRequested.current = false;
    });
  }, []);

  // Session-scoped chat settings (feature-spec.md:7, :278) — plain React
  // state, so they persist across conversation switches but not reloads.
  const [chatSettings, setChatSettings] = useState<ChatSettings>({});

  useEffect(() => {
    let cancelled = false;
    Promise.all([api.me(), api.agentTrees()])
      .then(([meData, treeData]) => {
        if (cancelled) return;
        setMe(meData);
        setTrees(treeData);
      })
      .catch((e: Error) => {
        if (!cancelled) setError(e.message);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (error) {
    return (
      <Center h="100vh">
        <Alert color="red" title="Backend unreachable">
          {error} — is the mock running on :4010? (npm run mock)
        </Alert>
      </Center>
    );
  }
  if (!me || !trees) {
    return (
      <Center h="100vh">
        <Loader />
      </Center>
    );
  }

  const tree = trees.some((t) => t.id === DEFAULT_TREE)
    ? DEFAULT_TREE
    : (trees[0]?.id ?? DEFAULT_TREE);

  return (
    <AppContext.Provider
      value={{
        me,
        trees,
        tree,
        conversationsVersion,
        refreshConversations,
        models,
        ensureModels,
        chatSettings,
        setChatSettings,
      }}
    >
      {/* P1-T08: ONE app-wide /tasks/stream subscription, opened on boot —
          feeds the queue panel and the sidebar badge (feature-spec.md:108,
          :111). Design notes in QueueContext.tsx. */}
      <QueueProvider>
      <Routes>
        <Route element={<Shell />}>
          <Route index element={<Navigate to="/chat" replace />} />
          <Route path="/chat" element={<ChatPage />} />
          <Route path="/chat/:conversationId" element={<ChatPage />} />
          <Route path="/runs" element={<RunsPage />} />
          {/* Step 3 Results — also the detail route for stored runs (P1-T11). */}
          <Route path="/runs/:runId" element={<RunDetailPage />} />
          {/* P1-T14 sibling fork comparison — "compare forks of the same turn
              across endpoints" (feature-spec.md:73), reached from a fork's
              lineage banner (design rationale in ForkComparePage.tsx). */}
          <Route path="/forks/:parentId/:turnId" element={<ForkComparePage />} />
          {/* P1-T16 trace — one route for every ⌁ entry ("Works on originals,
              forks, and replays alike", feature-spec.md:145); tree from
              context like all pages. */}
          <Route path="/trace/:turnId" element={<TracePage />} />
          <Route path="/queue" element={<QueuePage />} />
          <Route path="/agents" element={<AgentsPage />} />
          {/* Editor route target for node click / "Edit instructions"
              (feature-spec.md:26) — placeholder page until P1-T10b. */}
          <Route path="/agents/:agentId/editor" element={<EditorPage />} />
          <Route path="/agents/:agentId/conversations" element={<AgentConversationsPage />} />
        </Route>
      </Routes>
      </QueueProvider>
    </AppContext.Provider>
  );
}
