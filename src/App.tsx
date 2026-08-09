import { useCallback, useEffect, useEffectEvent, useMemo, useRef, useState } from "react";
import { Navigate, Route, Routes, useLocation, useNavigate, useParams } from "react-router";
import { Alert, Button, Center, Loader, Stack } from "@mantine/core";
import { api, ApiError } from "./api/client";
import { agenticConfig } from "../agentic.config";
import { resolveDefaultTargetId, setActiveTarget, useBackendTarget } from "./api/target";
import { onAuthRequired, useAuthToken } from "./api/auth";
import { loginPath, RETURN_TO_PARAM, sanitizeReturnTo } from "./lib/returnTo";
import type { Model } from "./api/types";
import { useAsync } from "./hooks/useAsync";
import { AppContext } from "./AppContext";
import { QueueProvider } from "./QueueContext";
import { Shell } from "./shell/Shell";
import { ChatPage } from "./pages/ChatPage";
import { EvaluationsPage } from "./pages/EvaluationsPage";
import { EvaluationPage } from "./pages/EvaluationPage";
import { QueuePage } from "./pages/QueuePage";
import { AgentsPage } from "./pages/AgentsPage";
import { EditorPage } from "./pages/EditorPage";
import { AgentConversationsPage } from "./pages/AgentConversationsPage";
import { ForkComparePage } from "./pages/ForkComparePage";
import { TracePage } from "./pages/TracePage";
import { EvalPage } from "./pages/EvalPage";
import { InspectorPage } from "./pages/InspectorPage";
import { SettingsPage } from "./pages/SettingsPage";
import { LoginPage } from "./pages/LoginPage";

const DEFAULT_TREE = "agent1";

// Mid-session 401s (expired token during use). The client clears the
// token and emits auth-required (client.ts); this listener navigates to
// /login?return_to=<current full path incl. query> so login returns the user
// exactly where they were — the mechanism share deep links rely on.
function AuthRequiredRedirect() {
  const navigate = useNavigate();
  const location = useLocation();
  // Effect event: subscribe once, but read the CURRENT location when the
  // signal fires — re-subscribing per navigation would drop a 401 racing it.
  const redirectToLogin = useEffectEvent(() => {
    if (location.pathname !== "/login") navigate(loginPath(location));
  });
  useEffect(() => onAuthRequired(redirectToLogin), []);
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

// /runs and /runs/{id} were the pre-rename paths and are in the wild as shared
// deep links, so they redirect instead of 404ing. Query + hash ride along
// (a shared link may carry them); `replace` keeps Back out of a redirect loop.
function LegacyRunsRedirect() {
  const { evaluationId } = useParams();
  const { search, hash } = useLocation();
  return <Navigate to={`/evaluations${evaluationId ? `/${evaluationId}` : ""}${search}${hash}`} replace />;
}

export function App() {
  // Boot: GET /me is always called (invariant, cupel-phases.md:160) alongside
  // GET /agenttrees (feature-spec.md:221 "App shell / sidebar | GET /me, GET /agenttrees").
  const [conversationsVersion, setConversationsVersion] = useState(0);
  const refreshConversations = useCallback(() => {
    setConversationsVersion((v) => v + 1);
  }, []);

  // GET /models fetched lazily on first settings-menu open, once per
  // session (feature-spec.md:118). Ref guards a duplicate in-flight fetch;
  // cleared on failure so a later open can retry.
  //
  // Models are per-backend (GET {base}/models), so the cache is TAGGED with the
  // backend identity it was fetched under and read back only while that tag
  // still matches — a switch invalidates it during render instead of through a
  // reset effect. `backendKey` is declared below, next to the boot fetch that
  // defines what "the current backend" means.
  const [modelsCache, setModelsCache] = useState<{ key: unknown; models: Model[] } | null>(
    null,
  );
  const modelsRequested = useRef<unknown>(null);

  // Live switch: the boot fetch is KEYED ON THE ACTIVE TARGET. On
  // switch (Settings → Backend), me/trees reset to null → the loader renders
  // and the whole page tree (Shell, QueueProvider's /tasks/stream, every
  // page's mount fetch) unmounts; when /me + /agenttrees resolve against the
  // new base, everything remounts fresh and refetches there. /me is always
  // called — including once per switch (invariant, cupel-phases.md:160); a
  // failing new target lands in the boot error state below, which names it.
  // `target` is referentially stable per id (target.ts snapshot contract),
  // so the effect fires only on real changes (or a custom-URL edit).
  // ALSO keyed on the login token — login (token set) and logout
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
  const { data: boot, error } = useAsync(
    () => Promise.all([api.me(), api.agentTrees()]),
    [target, authToken, bootNonce],
  );
  const me = boot?.[0] ?? null;
  const trees = boot?.[1] ?? null;
  const rebootIfBooted = useEffectEvent(() => {
    if (me !== null) setBootNonce((n) => n + 1);
  });
  useEffect(() => onAuthRequired(rebootIfBooted), []);

  // One identity for "the backend everything downstream is talking to" — a new
  // array whenever any of the three change (target compares by reference, so a
  // custom-URL edit counts even though the id did not move). The models cache
  // above is read back only while its tag is still this array, which makes the
  // switch invalidate it during render.
  const backendKey = useMemo(
    () => [target, authToken, bootNonce] as const,
    [target, authToken, bootNonce],
  );
  const models = modelsCache?.key === backendKey ? modelsCache.models : null;
  const ensureModels = useCallback(() => {
    if (modelsRequested.current === backendKey) return;
    modelsRequested.current = backendKey;
    api
      .models()
      .then((list) => setModelsCache({ key: backendKey, models: list }))
      .catch(() => {
        if (modelsRequested.current === backendKey) modelsRequested.current = null;
      });
  }, [backendKey]);

  if (error instanceof ApiError && error.status === 401) {
    // Boot 401 (auth-on backend, no/expired token) → the login
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
    // Target-aware hint: the boot error names the ACTIVE backend
    // target instead of hardcoding the mock host. Plus the recovery
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
      {/* ONE app-wide /tasks/stream subscription, opened on boot —
          feeds the queue panel and the sidebar badge (feature-spec.md:104,
          :111). Design notes in QueueContext.tsx. */}
      <QueueProvider>
      {/* Mid-session 401 → /login?return_to=… (see component). */}
      <AuthRequiredRedirect />
      <Routes>
        {/* Booted app at /login (already authenticated, or the post-login
            race) bounces to the validated return_to. */}
        <Route path="/login" element={<LoginBounce />} />
        <Route element={<Shell />}>
          <Route index element={<Navigate to="/chat" replace />} />
          <Route path="/chat" element={<ChatPage />} />
          <Route path="/chat/:conversationId" element={<ChatPage />} />
          <Route path="/evaluations" element={<EvaluationsPage />} />
          {/* Step 3 Results — also the detail route for stored evaluations. */}
          <Route path="/evaluations/:evaluationId" element={<EvaluationPage />} />
          {/* Pre-rename paths, still live in shared links (see above). */}
          <Route path="/runs" element={<LegacyRunsRedirect />} />
          <Route path="/runs/:evaluationId" element={<LegacyRunsRedirect />} />
          {/* Sibling fork comparison — "compare forks of the same turn
              across endpoints" (feature-spec.md:73), reached from a fork's
              lineage banner (design rationale in ForkComparePage.tsx). */}
          <Route path="/forks/:parentId/:turnId" element={<ForkComparePage />} />
          {/* Trace — one route for every ⌁ entry ("Works on originals,
              forks, and replays alike", feature-spec.md:141); tree from
              context like all pages. */}
          <Route path="/trace/:turnId" element={<TracePage />} />
          {/* Eval workbench (sketch 10) — "manage the eval domain
              directly: case editor …, set manager …, rubric editor"
              (feature-spec.md:63). Global, not tree-scoped
              (feature-spec.md:111), so the route carries no tree. */}
          {/* Its Sets tab is also where collected turns land: Casebook and
              EvalSet are one noun now, so there is no second route. */}
          <Route path="/eval" element={<EvalPage />} />
          {/* Inspector — ROLE-gated, never mode-gated: the route
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
              (feature-spec.md:26). */}
          <Route path="/agents/:agentId/editor" element={<EditorPage />} />
          <Route path="/agents/:agentId/conversations" element={<AgentConversationsPage />} />
          {/* Settings — Backend section first (sketch 09); generator and
              memory sections come later. */}
          <Route path="/settings" element={<SettingsPage />} />
        </Route>
      </Routes>
      </QueueProvider>
    </AppContext.Provider>
  );
}
