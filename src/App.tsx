import { useCallback, useEffect, useRef, useState } from "react";
import { Navigate, Route, Routes, useLocation, useNavigate } from "react-router";
import { Alert, Button, Center, Loader, Stack } from "@mantine/core";
import { api, ApiError } from "./api/client";
import { agenticConfig } from "../agentic.config";
import { resolveDefaultTargetId, setActiveTarget, useBackendTarget } from "./api/target";
import { onAuthRequired, useAuthToken } from "./api/auth";
import { loginPath, RETURN_TO_PARAM, sanitizeReturnTo } from "./lib/returnTo";
import type { AgentTree, Me, Model } from "./api/types";
import { AppContext } from "./AppContext";
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
import { EvalPage } from "./pages/EvalPage";
import { InspectorPage } from "./pages/InspectorPage";
import { CasebooksPage } from "./pages/CasebooksPage";
import { SettingsPage } from "./pages/SettingsPage";
import { LoginPage } from "./pages/LoginPage";

const DEFAULT_TREE = "agent1";

// P2-T07: mid-session 401s (expired token during use). The client clears the
// token and emits auth-required (client.ts); this listener navigates to
// /login?return_to=<current full path incl. query> so login returns the user
// exactly where they were — the mechanism P2-SHARE deep links rely on.
function AuthRequiredRedirect() {
  const navigate = useNavigate();
  const location = useLocation();
  const locationRef = useRef(location);
  locationRef.current = location;
  useEffect(
    () =>
      onAuthRequired(() => {
        const current = locationRef.current;
        if (current.pathname !== "/login") navigate(loginPath(current));
      }),
    [navigate],
  );
  return null;
}

// Redirect the current location to /login, carrying it as return_to — used
// when boot itself 401s at a deep link.
function RedirectToLogin() {
  const location = useLocation();
  return <Navigate to={loginPath(location)} replace />;
}

// /login while already booted (e.g. login completed and boot resolved before
// navigation, or a signed-in user opens /login): bounce into the app at the
// validated return_to.
function LoginBounce() {
  const location = useLocation();
  const returnTo = new URLSearchParams(location.search).get(RETURN_TO_PARAM);
  return <Navigate to={sanitizeReturnTo(returnTo)} replace />;
}

export function App() {
  // Boot: GET /me is always called (invariant, cupel-phases.md:160) alongside
  // GET /agenttrees (feature-spec.md:225 "App shell / sidebar | GET /me, GET /agenttrees").
  const [me, setMe] = useState<Me | null>(null);
  const [trees, setTrees] = useState<AgentTree[] | null>(null);
  const [error, setError] = useState<Error | null>(null);
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

  // P2-T17 live switch: the boot fetch is KEYED ON THE ACTIVE TARGET. On
  // switch (Settings → Backend), me/trees reset to null → the loader renders
  // and the whole page tree (Shell, QueueProvider's /tasks/stream, every
  // page's mount fetch) unmounts; when /me + /agenttrees resolve against the
  // new base, everything remounts fresh and refetches there. /me is always
  // called — including once per switch (invariant, cupel-phases.md:160); a
  // failing new target lands in the boot error state below, which names it.
  // `target` is referentially stable per id (target.ts snapshot contract),
  // so the effect fires only on real changes (or a custom-URL edit).
  // P2-T07: ALSO keyed on the login token — login (token set) and logout
  // (token cleared) re-run the boot fetch, so /me is called again with the
  // new credentials (invariant "/me is always called", cupel-phases.md:160).
  const target = useBackendTarget();
  const authToken = useAuthToken();
  // A MID-SESSION auth-required signal also re-runs the boot check (covers a
  // 401 when no token was stored to clear — the boot lands on 401 → login
  // screen instead of leaving the stale booted tree up). Guarded on "already
  // booted": during boot the 401 lands in the catch below, and an unguarded
  // bump would loop boot → 401 → bump → boot forever.
  const [bootNonce, setBootNonce] = useState(0);
  const bootedRef = useRef(false);
  bootedRef.current = me !== null;
  useEffect(
    () =>
      onAuthRequired(() => {
        if (bootedRef.current) setBootNonce((n) => n + 1);
      }),
    [],
  );
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
        if (!cancelled) setError(e);
      });
    return () => {
      cancelled = true;
    };
  }, [target, authToken, bootNonce]);

  if (error instanceof ApiError && error.status === 401) {
    // P2-T07: boot 401 (auth-on backend, no/expired token) → the login
    // screen instead of the error screen (task rule: "401 at boot → login").
    // The current deep link is preserved as return_to; after login the token
    // change re-runs the boot effect above. Off-mode backends never 401 here,
    // so this path simply never renders — no component branches on the mode.
    return (
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route path="*" element={<RedirectToLogin />} />
      </Routes>
    );
  }
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
            {error.message} — is the {target.label} backend at{" "}
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
      }}
    >
      {/* P1-T08: ONE app-wide /tasks/stream subscription, opened on boot —
          feeds the queue panel and the sidebar badge (feature-spec.md:108,
          :111). Design notes in QueueContext.tsx. */}
      <QueueProvider>
      {/* P2-T07: mid-session 401 → /login?return_to=… (see component). */}
      <AuthRequiredRedirect />
      <Routes>
        {/* Booted app at /login (already authenticated, or the post-login
            race) bounces to the validated return_to. */}
        <Route path="/login" element={<LoginBounce />} />
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
          {/* P2-T12 Eval workbench (sketch 10) — "manage the eval domain
              directly: case editor …, set manager …, rubric editor"
              (feature-spec.md:63). Global, not tree-scoped
              (feature-spec.md:115), so the route carries no tree. */}
          <Route path="/eval" element={<EvalPage />} />
          {/* P2-T12a Casebooks — global like Eval (a casebook may reference
              turns across trees, openapi.yaml:1654-1656), so no tree in the
              route. Open to any signed-in user: the contract role-gates the
              Inspector, not /casebooks. */}
          <Route path="/casebooks" element={<CasebooksPage />} />
          {/* P2-T12a Inspector — ROLE-gated, never mode-gated: the route
              exists only when /me.roles includes `inspect` (openapi.yaml:308
              "Requires the inspect role"). Without it the path falls through
              to the index redirect, so a hand-typed /inspector cannot render
              a screen whose every request would 403. */}
          {me.roles?.includes("inspect") && (
            <Route path="/inspector" element={<InspectorPage />} />
          )}
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
