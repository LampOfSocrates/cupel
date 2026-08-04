import { useEffect, useState } from "react";
import { Navigate, Route, Routes } from "react-router";
import { Alert, Center, Loader } from "@mantine/core";
import { api } from "./api/client";
import type { AgentTree, Me } from "./api/types";
import { AppContext } from "./AppContext";
import { Shell } from "./shell/Shell";
import { ChatPage } from "./pages/ChatPage";
import { RunsPage } from "./pages/RunsPage";
import { QueuePage } from "./pages/QueuePage";
import { AgentsPage } from "./pages/AgentsPage";

const DEFAULT_TREE = "agent1";

export function App() {
  // Boot: GET /me is always called (invariant, loom-phases.md:160) alongside
  // GET /agenttrees (feature-spec.md:225 "App shell / sidebar | GET /me, GET /agenttrees").
  const [me, setMe] = useState<Me | null>(null);
  const [trees, setTrees] = useState<AgentTree[] | null>(null);
  const [error, setError] = useState<string | null>(null);

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
    <AppContext.Provider value={{ me, trees, tree }}>
      <Routes>
        <Route element={<Shell />}>
          <Route index element={<Navigate to="/chat" replace />} />
          <Route path="/chat" element={<ChatPage />} />
          <Route path="/chat/:conversationId" element={<ChatPage />} />
          <Route path="/runs" element={<RunsPage />} />
          <Route path="/queue" element={<QueuePage />} />
          <Route path="/agents" element={<AgentsPage />} />
        </Route>
      </Routes>
    </AppContext.Provider>
  );
}
