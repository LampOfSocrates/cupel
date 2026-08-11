import { useCallback, useEffect, useMemo, useState } from "react";
import { Outlet, useLocation, useNavigate } from "react-router";
import { Alert, Badge, Group, Stack, Tabs, Text, Title } from "@mantine/core";
import { api } from "../../api/client";
import { useApp } from "../../AppContext";
import { ApiErrorNote, errorMessage } from "../../components/ApiErrorNote";
import { product } from "../../lib/product";
import { isHidden, visibleStudioTabs } from "../../lib/families";
import { StudioProvider, type StudioContextValue } from "./StudioContext";
import type { EvaluationDraft } from "./evaluationDraft";
import { EVALUATION_DRAFT_KEY } from "./evaluationDraft";
import type { EvalBenchmark, EvalCase, Rubric } from "../../api/types";

// The Studio frame — the layout route every tab renders inside.
//
// The tabs are routes now (/studio/cases, /studio/rubrics,
// /studio/evaluations/{id}, …), not <Tabs.Panel> values, and this component is
// what makes that worth doing: it stays mounted across the whole workflow, so
// the tab strip is still on screen while you read an evaluation grid. Reading a
// result used to mean leaving for a full-page /evaluations/{id} — the tabs
// vanished exactly when you most wanted to jump back to Cases and fix a bad
// reference.
//
// The strip is still Mantine <Tabs> for its looks and its roles; only onChange
// changed, from a setState to a navigation.
//
// Everything the tabs share — the benchmark list, the case cache, the rubric
// list, the error alert — is owned here and read through useStudio(), because
// a tab that unmounts cannot own a cache two other tabs read. See
// StudioContext.tsx.
//
// Eval cases are GLOBAL, not tree-scoped ("Global: tasks, span payloads, eval
// rubrics/judgments, settings", feature-spec.md:111) — no tree gating here. The
// tree-scoped things it contains (the turn picker, the evaluation grid) carry
// their own.

export function StudioFrame() {
  const { me, models, ensureModels } = useApp();
  const navigate = useNavigate();
  const { pathname } = useLocation();

  const inspectorAllowed = (me.roles?.includes("inspect") ?? false) && !isHidden("admin");
  const tabs = visibleStudioTabs({ inspectorAllowed });
  // /studio/evaluations/{id} is still the Evaluations tab: the segment under
  // /studio is the tab, whatever hangs off it.
  const active = pathname.split("/")[2] ?? null;

  const casesHidden = isHidden("datasets");
  const rubricsHidden = isHidden("judging");

  const [benchmarks, setBenchmarks] = useState<EvalBenchmark[] | null>(null);
  const [rubrics, setRubrics] = useState<Rubric[] | null>(null);
  // GET /eval/benchmarks and GET /eval/rubrics are paged, so both lists here
  // are prefixes. Holding the server's total is what lets each tab offer the
  // rest instead of ending silently at the page boundary; both are 0 until
  // the first fetch lands.
  const [benchmarksPage, setBenchmarksPage] = useState({ page: 1, total: 0 });
  const [rubricsPage, setRubricsPage] = useState({ page: 1, total: 0 });
  // The thrown VALUE, not its message: an ApiError carries the rejected
  // fields and the correlation id, and flattening it to a string here threw
  // both away before the Alert could show them.
  const [error, setError] = useState<unknown>(null);

  // Cases known to this screen, keyed by id. There is no list-all-cases
  // endpoint — /eval/cases has POST only (openapi.yaml:1875) and cases are read
  // one id at a time (openapi.yaml:1975) — so this is a cache of what the
  // Cases tab loaded per benchmark plus whatever was created here, never a
  // listing.
  const [cases, setCases] = useState<Record<string, EvalCase>>({});
  const [sessionCaseIds, setSessionCaseIds] = useState<string[]>([]);

  // Buffers that outlive their own tab — see useStudioState in StudioContext.
  const [bag, setBag] = useState<Record<string, unknown>>({});

  useEffect(() => {
    ensureModels();
  }, [ensureModels]);

  const loadBenchmarks = useCallback(async () => {
    const page = await api.evalBenchmarks();
    setBenchmarks(page.items);
    setBenchmarksPage({ page: page.page, total: page.total });
    return page.items;
  }, []);

  const loadMoreBenchmarks = useCallback(async () => {
    const page = await api.evalBenchmarks({ page: benchmarksPage.page + 1 });
    setBenchmarks((prev) => [...(prev ?? []), ...page.items]);
    setBenchmarksPage({ page: page.page, total: page.total });
  }, [benchmarksPage.page]);

  const reloadRubrics = useCallback(async () => {
    const page = await api.rubrics();
    setRubrics(page.items);
    setRubricsPage({ page: page.page, total: page.total });
  }, []);

  const loadMoreRubrics = useCallback(async () => {
    const page = await api.rubrics({ page: rubricsPage.page + 1 });
    setRubrics((prev) => [...(prev ?? []), ...page.items]);
    setRubricsPage({ page: page.page, total: page.total });
  }, [rubricsPage.page]);

  const rememberCase = useCallback((c: EvalCase) => {
    setCases((prev) => ({ ...prev, [c.id]: c }));
    setSessionCaseIds((prev) => (prev.includes(c.id) ? prev : [...prev, c.id]));
  }, []);

  // A family answered `hide` has no tab and no route, so it must have no
  // REQUEST either — the old page fetched both lists on mount regardless of
  // which tabs it was about to render.
  useEffect(() => {
    let cancelled = false;
    if (!casesHidden) {
      api
        .evalBenchmarks()
        .then((page) => {
          if (cancelled) return;
          setBenchmarks(page.items);
          setBenchmarksPage({ page: page.page, total: page.total });
        })
        .catch((e: unknown) => {
          if (!cancelled) setError(e);
        });
    }
    if (!rubricsHidden) {
      api
        .rubrics()
        .then((page) => {
          if (cancelled) return;
          setRubrics(page.items);
          setRubricsPage({ page: page.page, total: page.total });
        })
        .catch((e: unknown) => {
          if (!cancelled) setError(e);
        });
    }
    return () => {
      cancelled = true;
    };
  }, [casesHidden, rubricsHidden]);

  const knownCaseIds = useMemo(
    () =>
      Array.from(
        new Set([
          ...sessionCaseIds,
          ...(benchmarks ?? []).flatMap((b) =>
            b.items.filter((i) => i.case_id).map((i) => i.case_id as string),
          ),
        ]),
      ),
    [sessionCaseIds, benchmarks],
  );

  const rubricOptions = useMemo(
    () => (rubrics ?? []).map((r) => ({ value: r.id, label: `${r.name} v${r.version}` })),
    [rubrics],
  );
  const modelOptions = useMemo(
    () => (models ?? []).map((m) => ({ value: m.id, label: m.name })),
    [models],
  );

  const value: StudioContextValue = {
    benchmarks,
    benchmarksTotal: benchmarksPage.total,
    loadBenchmarks,
    loadMoreBenchmarks,
    rubrics,
    rubricsTotal: rubricsPage.total,
    reloadRubrics,
    loadMoreRubrics,
    cases,
    setCases,
    sessionCaseIds,
    rememberCase,
    knownCaseIds,
    rubricOptions,
    modelOptions,
    error,
    setError,
    bag,
    setBag,
  };

  // A configured-but-unqueued evaluation is easy to walk away from now that the
  // stepper is a route you can navigate off — so the tab says it is still
  // there rather than letting it vanish silently.
  const draft = bag[EVALUATION_DRAFT_KEY] as EvaluationDraft | undefined;
  const draftPending = (draft?.selection.length ?? 0) > 0;

  return (
    <StudioProvider value={value}>
      <Stack gap="sm" p="md">
        <Group justify="space-between">
          <Title order={4}>Studio</Title>
          <Text size="xs" c="dimmed">
            Cases, benchmarks and rubrics are global — they are not scoped to a single{" "}
            {product.tree.one}.
          </Text>
        </Group>
        {error != null && (
          <Alert
            color="red"
            title="Something went wrong"
            withCloseButton
            onClose={() => setError(null)}
          >
            {errorMessage(error)}
            <ApiErrorNote error={error} />
          </Alert>
        )}

        <Tabs value={active} onChange={(segment) => segment && navigate(`/studio/${segment}`)}>
          <Tabs.List>
            {tabs.map((tab) => (
              <Tabs.Tab
                key={tab.segment}
                value={tab.segment}
                rightSection={
                  tab.segment === "evaluations" && draftPending ? (
                    <Badge size="xs" variant="light" circle data-testid="evaluation-draft-dot">
                      •
                    </Badge>
                  ) : undefined
                }
              >
                {tab.label}
              </Tabs.Tab>
            ))}
          </Tabs.List>
        </Tabs>

        <Outlet />
      </Stack>
    </StudioProvider>
  );
}
