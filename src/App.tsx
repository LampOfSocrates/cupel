import { useCallback, useEffect, useEffectEvent, useMemo, useRef, useState } from "react";
import { Navigate, Route, Routes, useLocation, useNavigate, useParams } from "react-router";
import { Alert, Button, Center, Loader, Stack } from "@mantine/core";
import { useLocalStorage } from "@mantine/hooks";
import { api, ApiError } from "./api/client";
import { agenticConfig } from "../agentic.config";
import { resolveDefaultTargetId, setActiveTarget, useBackendTarget } from "./api/target";
import { onAuthRequired, useAuthToken } from "./api/auth";
import { loginPath, RETURN_TO_PARAM, sanitizeReturnTo } from "./lib/returnTo";
import { defaultStudioPath, isHidden, isRouteHidden, isStudioHidden, landingRoute } from "./lib/families";
import type { Model } from "./api/types";
import { useAsync } from "./hooks/useAsync";
import { AppContext } from "./AppContext";
import { QueueProvider } from "./QueueContext";
import { Shell } from "./shell/Shell";
import { ChatPage } from "./pages/ChatPage";
import { EvaluationPage } from "./pages/EvaluationPage";
import { QueuePage } from "./pages/QueuePage";
import { AgentsPage } from "./pages/AgentsPage";
import { EditorPage } from "./pages/EditorPage";
import { AgentConversationsPage } from "./pages/AgentConversationsPage";
import { ForkComparePage } from "./pages/ForkComparePage";
import { TracePage } from "./pages/TracePage";
import { StudioFrame } from "./pages/studio/StudioFrame";
import { CasesTab } from "./pages/studio/CasesTab";
import { BenchmarksTab } from "./pages/studio/BenchmarksTab";
import { RubricsTab } from "./pages/studio/RubricsTab";
import { EvaluationsPage } from "./pages/EvaluationsPage";
import { InspectorPage } from "./pages/InspectorPage";
import { SettingsPage } from "./pages/SettingsPage";
import { LoginPage } from "./pages/LoginPage";

const DEFAULT_TREE = "agent1";

// A family answered `hide` in agentic.config.ts has no routes at all — the
// same treatment the Inspector's role gate gives an unpermitted screen, and
// for the same reason: a page whose whole API surface is absent must not
// render. The sidebar hides the matching doors (shell/Sidebar.tsx).
const visible = (route: string) => !isRouteHidden(route);

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

// Every Studio tab is a path now (/studio/cases, /studio/evaluations/{id}, …),
// so three generations of link are in the wild and all of them still resolve.
// Query + hash ride along (a shared link may carry them); `replace` keeps Back
// out of a redirect loop.
//
// /runs and /runs/{id} are the oldest — the pre-rename paths. Bare /runs meant
// "the evaluations list", which is Studio's Evaluations tab.
function LegacyRunsRedirect() {
  const { evaluationId } = useParams();
  const { search, hash } = useLocation();
  const suffix = evaluationId ? `/${evaluationId}` : "";
  return <Navigate to={`/studio/evaluations${suffix}${search}${hash}`} replace />;
}

// /evaluations/{id} was the standalone results grid. It is Studio's third
// evaluation step now — the whole point of the move being that reading a result
// no longer costs you the tab strip.
function LegacyEvaluationRedirect() {
  const { evaluationId } = useParams();
  const { search, hash } = useLocation();
  return <Navigate to={`/studio/evaluations/${evaluationId}${search}${hash}`} replace />;
}

// /inspector was its own route before the Studio merge; its filters live in
// the URL by design (InspectorPage.tsx, "an inspection is a shareable
// link"), so old links keep those filters rather than 404ing.
function LegacyInspectorRedirect() {
  const { search, hash } = useLocation();
  return <Navigate to={`/studio/inspector${search}${hash}`} replace />;
}

// The tab was a `?tab=` query before it was a path, and that form is in the
// wild too (shared links, the editor's Test-as-evaluation handoff, /runs
// bookmarks that already redirected once). `results` is the rename: the tab is
// Evaluations, and only its THIRD STEP is a set of results.
const STUDIO_TAB_ALIASES: Record<string, string> = { results: "evaluations", sets: "benchmarks" };

// A bare /studio: honour a legacy ?tab= if there is one, else open the first
// tab this viewer can see. An unknown or hidden tab name falls through to the
// same default via the /studio catch-all below.
function StudioIndexRedirect({ home }: { home: string }) {
  const { search, hash } = useLocation();
  const params = new URLSearchParams(search);
  const tab = params.get("tab");
  if (tab) {
    params.delete("tab");
    const rest = params.toString();
    return (
      <Navigate
        to={`/studio/${STUDIO_TAB_ALIASES[tab] ?? tab}${rest ? `?${rest}` : ""}${hash}`}
        replace
      />
    );
  }
  return <Navigate to={`${home}${search}${hash}`} replace />;
}

export function App() {
  // Boot: GET /me is always called (invariant) alongside
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
  // called — including once per switch (invariant); a
  // failing new target lands in the boot error state below, which names it.
  // `target` is referentially stable per id (target.ts snapshot contract),
  // so the effect fires only on real changes (or a custom-URL edit).
  // ALSO keyed on the login token — login (token set) and logout
  // (token cleared) re-run the boot fetch, so /me is called again with the
  // new credentials (invariant "/me is always called").
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

  // The user's last pick, device-locally persisted like the backend-target
  // picker (src/api/target.ts) and the sidebar-rail-collapsed flag
  // (Shell.tsx) — same convention, same mechanism. Hook called unconditionally
  // (before the early returns below) so render order never changes; the
  // ENABLED check happens once `trees` is known, just below.
  const [storedTree, setStoredTree] = useLocalStorage({
    key: "cupel-active-tree",
    defaultValue: DEFAULT_TREE,
  });
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

  // AgentTree.enabled (openapi.yaml) is toggled via PATCH /admin/agenttrees —
  // "false is only ever seen by admins (non-admin listings omit disabled
  // trees)". So a disabled tree can only reach this list for an admin viewer,
  // and it must never become the ACTIVE one regardless: prefer the stored
  // pick if it's currently enabled, else DEFAULT_TREE if enabled, else the
  // first enabled tree, else — no enabled tree at all, an edge case the old
  // code didn't consider either — fall back the same way it used to.
  const enabledTrees = trees.filter((t) => t.enabled);
  const tree = enabledTrees.some((t) => t.id === storedTree)
    ? storedTree
    : (enabledTrees.find((t) => t.id === DEFAULT_TREE)?.id ??
      enabledTrees[0]?.id ??
      trees[0]?.id ??
      DEFAULT_TREE);
  // Not memoized — deliberately a plain closure defined post-null-check
  // (trees is narrowed to non-null here), same as `tree` above. The Provider
  // value below is already a fresh object every render, so a stable identity
  // here would buy nothing.
  const setTree = (id: string) => {
    if (trees.some((t) => t.id === id && t.enabled)) setStoredTree(id);
  };

  // The Inspector is the one screen gated on a ROLE as well as a family, and
  // Studio's landing tab depends on whether it survives both — so the pair is
  // resolved once, here, and shared by every place below that needs it.
  const inspectorAllowed = (me.roles?.includes("inspect") ?? false) && !isHidden("admin");
  const studioHome = defaultStudioPath({ inspectorAllowed });

  return (
    <AppContext.Provider
      value={{
        me,
        trees,
        tree,
        setTree,
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
          {/* /chat unless chat is hidden — see lib/families landingRoute. */}
          <Route index element={<Navigate to={landingRoute()} replace />} />
          {visible("/chat") && (
            <>
              <Route path="/chat" element={<ChatPage />} />
              <Route path="/chat/:conversationId" element={<ChatPage />} />
            </>
          )}
          {/* Pre-split path for the results grid — now Studio's third
              evaluation step. Still linked from the wild (share links, old
              bookmarks), so it redirects rather than 404s. */}
          {visible("/evaluations") && (
            <Route path="/evaluations/:evaluationId" element={<LegacyEvaluationRedirect />} />
          )}
          {/* Pre-rename paths, still live in shared links (see above). */}
          <Route path="/runs" element={<LegacyRunsRedirect />} />
          <Route path="/runs/:evaluationId" element={<LegacyRunsRedirect />} />
          {/* Sibling fork comparison — "compare forks of the same turn
              across endpoints" (feature-spec.md:73), reached from a fork's
              lineage banner (design rationale in ForkComparePage.tsx). */}
          {visible("/forks") && (
            <Route path="/forks/:parentId/:turnId" element={<ForkComparePage />} />
          )}
          {/* Trace — one route for every ⌁ entry ("Works on originals,
              forks, and replays alike", feature-spec.md:141); tree from
              context like all pages. */}
          {visible("/trace") && <Route path="/trace/:turnId" element={<TracePage />} />}
          {/* Studio (sketch 10, formerly /eval "Eval workbench" +
              /evaluations "Evaluations" + /inspector): case editor, benchmark
              manager, rubric editor, the evaluation flow, and (role-gated) the
              Inspector. Global, not tree-scoped (feature-spec.md:111), so the
              route carries no tree. Visible if ANY family it merges still
              answers something other than hide (isStudioHidden).

              EACH TAB IS A ROUTE, under a layout route that owns the tab strip
              and the shared caches (pages/studio/StudioFrame.tsx). That is what
              lets the evaluation grid — /studio/evaluations/{id}, the flow's
              third step — render WITH the tabs still on screen instead of
              replacing the whole page, and what makes the URL name one thing
              each. A hidden family loses its child route the same way it loses
              its top-level one; anything unmatched inside /studio falls to the
              first tab this viewer can see rather than a bare frame. */}
          {!isStudioHidden() && (
            <Route path="/studio" element={<StudioFrame />}>
              <Route index element={<StudioIndexRedirect home={studioHome} />} />
              {!isHidden("datasets") && (
                <>
                  <Route path="cases" element={<CasesTab />} />
                  <Route path="benchmarks" element={<BenchmarksTab />} />
                </>
              )}
              {!isHidden("judging") && <Route path="rubrics" element={<RubricsTab />} />}
              {!isHidden("replay") && (
                <>
                  <Route path="evaluations" element={<EvaluationsPage mode="list" />} />
                  <Route path="evaluations/new" element={<EvaluationsPage mode="stepper" />} />
                  <Route path="evaluations/:evaluationId" element={<EvaluationPage />} />
                </>
              )}
              {inspectorAllowed && <Route path="inspector" element={<InspectorPage />} />}
              <Route path="*" element={<Navigate to={studioHome} replace />} />
            </Route>
          )}
          {/* Old standalone paths — see the redirect components above for
              why each still resolves instead of 404ing. */}
          <Route path="/eval" element={<Navigate to="/studio" replace />} />
          {inspectorAllowed && <Route path="/inspector" element={<LegacyInspectorRedirect />} />}
          {visible("/queue") && <Route path="/queue" element={<QueuePage />} />}
          {visible("/agents") && (
            <>
              {/* Editor nested (not a sibling): node click / "Edit
                  instructions" (feature-spec.md:26) opens it in AgentsPage's
                  own Outlet, so the tree stays mounted beside it — same
                  page, not a navigation away from it. */}
              <Route path="/agents" element={<AgentsPage />}>
                <Route path=":agentId/editor" element={<EditorPage />} />
              </Route>
              <Route path="/agents/:agentId/conversations" element={<AgentConversationsPage />} />
            </>
          )}
          {/* Settings — Backend section first (sketch 09); generator and
              memory sections come later. */}
          {visible("/settings") && <Route path="/settings" element={<SettingsPage />} />}
          {/* Anything unmatched — a hidden family's path typed by hand, a
              stale bookmark, a legacy redirect whose destination is hidden —
              lands on the app's front door rather than on a blank frame. */}
          <Route path="*" element={<Navigate to={landingRoute()} replace />} />
        </Route>
      </Routes>
      </QueueProvider>
    </AppContext.Provider>
  );
}
