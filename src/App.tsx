import { useCallback, useEffect, useRef, useState } from "react";
import { Navigate, Route, Routes } from "react-router";
import { Alert, Button, Center, Loader, Stack } from "@mantine/core";
import { api } from "./api/client";
import { agenticConfig } from "../agentic.config";
import { resolveDefaultTargetId, setActiveTarget, useBackendTarget } from "./api/target";
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
import { SettingsPage } from "./pages/SettingsPage";

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

  // P2-T17 live switch: the boot fetch is KEYED ON THE ACTIVE TARGET. On
  // switch (Settings → Backend), me/trees reset to null → the loader renders
  // and the whole page tree (Shell, QueueProvider's /tasks/stream, every
  // page's mount fetch) unmounts; when /me + /agenttrees resolve against the
  // new base, everything remounts fresh and refetches there. /me is always
  // called — including once per switch (invariant, skein-phases.md:160); a
  // failing new target lands in the boot error state below, which names it.
  // `target` is referentially stable per id (target.ts snapshot contract),
  // so the effect fires only on real changes (or a custom-URL edit).
  const target = useBackendTarget();
  useEffect(() => {
    let cancelled = false;
    setMe(null);
    setTrees(null);
    setError(null);
    // Models are per-backend (GET {base}/models) — drop the session cache so
    // the next settings-menu open refetches against the new target.
    setModels(null);
    modelsRequested.current = false;
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
  }, [target]);

  if (error) {
    // Target-aware hint (P2-CONFIG): the boot error names the ACTIVE backend
    // target instead of hardcoding the mock host. P2-T17 adds the recovery
    // path: a live switch to a dead target would otherwise strand the user
    // here (Settings is unreachable while boot fails) — offer the build's
    // default target as the way back; selecting it reruns the boot effect.
    const defaultId = resolveDefaultTargetId();
    const defaultTarget = agenticConfig.targets.find((t) => t.id === defaultId);
    return (
      <Center h="100vh">
        <Stack align="center" gap="sm">
          <Alert color="red" title="Backend unreachable">
            {error} — is the {target.label} backend at{" "}
            {target.baseUrl || "this origin"} running? (mock: npm run mock)
          </Alert>
          {defaultTarget && target.id !== defaultId && (
            <Button variant="default" size="xs" onClick={() => setActiveTarget(defaultId)}>
              Switch back to {defaultTarget.label}
            </Button>
          )}
        </Stack>
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
          {/* P2-T17 Settings — Backend section first (sketch 09); later
              tasks (T07 members, GEN generator, MEM memory) add sections. */}
          <Route path="/settings" element={<SettingsPage />} />
        </Route>
      </Routes>
      </QueueProvider>
    </AppContext.Provider>
  );
}
