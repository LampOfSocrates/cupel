import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router";
import {
  ActionIcon,
  Alert,
  Anchor,
  Badge,
  Box,
  Button,
  Group,
  Loader,
  Paper,
  Select,
  Stack,
  Text,
  Title,
} from "@mantine/core";
import { api } from "../api/client";
import type { JudgeConfig, Rubric, Run, RunCell } from "../api/types";
import { useAsync } from "../hooks/useAsync";
import {
  type CellContext,
  ComparisonView,
  ForkModal,
  JudgmentDrawer,
  ScoreChip,
  STATUS_COLOR,
} from "../components";
import { useApp } from "../AppContext";

// Runs step 3 — Results, and the detail route for old runs (feature-spec.md:49:
// "Comparison grid: baseline column + one column per run config, row per
// turn"). Live fill contract (openapi.yaml:678-680): "Cells fill incrementally
// as child tasks finish (feature-spec.md:112); live fill arrives via GET
// /tasks/stream" — this page subscribes to the stream and refetches GET run
// (debounced ~300ms) on task/progress events of this run's task family, until
// the run status is terminal (refetch-on-event is the documented baseline;
// cell patching is only an optimization). Unsubscribes on unmount/terminal.
//
// Eval layer (feature-spec.md:49 "If judge on: score column + summary
// header (mean, distribution sparkline), drill-in per turn for judge
// reasoning"; :64 "scores stream into the grid live as judging tasks finish
// (SSE) … summary header (mean + distribution) updates live"):
// - summary header from GET /eval/runs/{runId}/summary (openapi.yaml:1001-1022)
// - score chips via the grid's renderAnnotation slot on judged cells
//   (RunCell.case_id + latest_score, openapi.yaml:1654-1664); tap → drawer
// - judgment frames on /tasks/stream (openapi.yaml:1796-1804) refetch run +
//   summary on the same debounce
// - the stream stays subscribed past run-terminal WHILE a judging task is in
//   flight; judgments fired elsewhere (e.g. curl) appear on reload only.
//
// Cancel = DELETE /tasks/{task_id} on the run's parent task (openapi.yaml:
// 832-839 "Cancel a task … cancels queued/running children") — a small
// affordance only.

const TERMINAL = new Set<Run["status"]>(["done", "failed", "cancelled"]);
// A judging task still owns the run's scores while it is queued or running.
const TASK_IN_FLIGHT = new Set(["queued", "running"]);
const REFETCH_DEBOUNCE_MS = 300;

// The page is per-EVALUATION state wrapped around a per-SESSION shell. Rubrics
// (and the models the judge form needs) are neither, so they stay out here and
// are fetched once per mount; everything below them belongs to one (tree, runId)
// and is reset by REMOUNTING the body, the same key trick the instruction editor
// uses. That is what the old `useEffect(() => { setError(null); setStage(null);
// … }, [tree, runId])` was hand-rolling — and unlike that effect the key also
// catches the three per-run states it forgot (a half-typed judge config, an open
// cell re-fire modal, an in-flight cancel), which cannot outlive their run.
export function EvaluationPage() {
  const { tree, ensureModels } = useApp();
  const { runId = "" } = useParams();

  const [rubrics, setRubrics] = useState<Rubric[]>([]);
  // Rubrics label the summary header + feed the manual judge form; models feed
  // its judge-model select (feature-spec.md:122 "chat/run/judge model
  // dropdowns" — session cache). Missing rubric names degrade to raw ids.
  useEffect(() => {
    ensureModels();
    api.rubrics().then(setRubrics).catch(() => {});
  }, [ensureModels]);

  return <EvaluationBody key={`${tree}/${runId}`} rubrics={rubrics} />;
}

function EvaluationBody({ rubrics }: { rubrics: Rubric[] }) {
  const { tree, models } = useApp();
  const { runId = "" } = useParams();
  const navigate = useNavigate();

  const [error, setError] = useState<string | null>(null);
  // Latest progress stage text off the stream ("Conversation 3/10 · turn 2/6",
  // openapi.yaml:791-792; feature-spec.md:109).
  const [stage, setStage] = useState<string | null>(null);
  const [cancelling, setCancelling] = useState(false);
  // Cell re-fire target — the ⑂ modal is seeded with the CELL's source
  // turn (feature-spec.md:72 "'re-run this turn with…' on any results cell").
  const [forkSource, setForkSource] = useState<{
    conversation_id: string;
    turn_id: string;
  } | null>(null);
  // In-flight judging parent task (POST /eval/judge 202 TaskRef,
  // openapi.yaml:949-953) — non-null shows the subtle "judging…" state on the
  // header until the task's terminal frame arrives.
  const [judgeTaskId, setJudgeTaskId] = useState<string | null>(null);
  const [judgeFormOpen, setJudgeFormOpen] = useState(false);
  const [judgeDraft, setJudgeDraft] = useState<Partial<JudgeConfig>>({});
  // Chip tap target — "Tap a badge → judgment drawer" (feature-spec.md:64).
  const [drawerCaseId, setDrawerCaseId] = useState<string | null>(null);
  // Auto-judge bookkeeping (see the judge-trigger note below). judgeFired is
  // the per-mount latch; alive stops a check that outlives the page from
  // POSTing (it is re-armed by the effect body so React's StrictMode
  // double-invoke in dev cannot leave it false).
  const judgeFired = useRef(false);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  // Loads overlap (mount double-fetch, debounced refetches, judge handler) and
  // a SLOW stale response resolving after a newer one would overwrite terminal
  // state with "still running" — with no further frames due, the grid froze
  // there. useAsync's seq guard is what keeps
  // only the latest load applying. Summary rides the same (debounced) tick —
  // "summary header … updates live" (feature-spec.md:64).
  const {
    data: loaded,
    error: loadError,
    reload,
  } = useAsync(
    () => Promise.all([api.run(tree, runId), api.runSummary(runId)]),
    [tree, runId],
  );
  const run = loaded?.[0] ?? null;
  const summary = loaded?.[1] ?? null;

  const fireJudge = useCallback(
    // `silent`: the AUTO path must never replace the page with an error Alert
    // — a background judge that 422s ("Run has no finished cells to judge
    // yet") leaves the grid readable and the manual form available. The manual
    // path still surfaces its error, unchanged.
    async (judge_model: string, rubric_id: string, silent = false) => {
      try {
        // POST /eval/judge {run_id, judge_model, rubric_id} → 202 "Judging
        // enqueued (parent task + child per case)" (openapi.yaml:931-954);
        // run_id "auto-creating cases from conversation turns if none exist"
        // (feature-spec.md:61).
        const ref = await api.judge({ run_id: runId, judge_model, rubric_id });
        setJudgeTaskId(ref.task_id);
      } catch (e) {
        if (!silent) setError((e as Error).message);
      }
    },
    [runId],
  );

  // Judge trigger. The contract's judging path is POST /eval/judge —
  // replay configs carry `judge` (JudgeConfig, openapi.yaml:1508-1514) as the
  // UI's recorded intent, and the CLIENT fires it.
  //
  // THE RULE: judge a
  // run that IS done and carries a judge config and has not been judged yet —
  // NOT "judge a run I happened to watch finish". The old trigger keyed off a
  // live non-terminal → done transition, so opening a run link after the run
  // had already finished silently produced no scores at all.
  //
  // AUTO-JUDGE PREDICATE — all five must hold:
  //   1. run.id === runId && run.status === "done" — the aggregate replay
  //      succeeded. `failed`/`cancelled` never auto-judge (there is nothing
  //      the user asked to score, and the manual affordance is hidden for
  //      them too). A PARTIALLY-failed run reports status `done` (the batch
  //      parent goes done with failed children, mock/engine.py:431-433) and
  //      DOES auto-judge: the server judges only the finished cells
  //      (mock/main.py:1805-1807), so the failures are simply not scored, and
  //      a run whose cells ALL failed answers 422 — swallowed above.
  //   2. some column config carries a JudgeConfig — the judge is taken from
  //      the FIRST config that has one, one judging pass per run (per-config
  //      judges would need per-column case partitioning the contract doesn't
  //      model).
  //   3. GET /eval/judgments?run_id&rubric_id is EMPTY — "already judged" is
  //      read from the append-only store, not from client state, so it
  //      survives reload/remount/another tab. Scope: this run × this rubric,
  //      ANY version and ANY judge_model (JudgeConfig pins neither, and a
  //      rubric that has since versioned is still "this rubric"). Thumbs
  //      can't collide: type human judgments carry run_id null
  //      (openapi.yaml:1886-1887).
  //   4. no judge task for this run is queued/running — closes the window
  //      between POST /eval/judge and the first judgment landing (a reload
  //      mid-judging). The in-flight task is ADOPTED instead: the judging…
  //      badge and the live subscription come back on reload.
  //   5. judgeFired — a per-mount latch, set synchronously before the first
  //      await so a re-render mid-check cannot start a second one.
  //
  // RESIDUAL RACE (cannot be closed client-side): two tabs that both reach
  // step 3 before either's POST creates its task will both judge, appending
  // duplicates. Only a server-side Idempotency-Key on the 202 fixes that —
  // it is bucket C, and openapi.yaml is frozen here.
  const autoJudge =
    run?.id === runId && run.status === "done"
      ? (run.columns.map((c) => c.config.judge).find((j): j is JudgeConfig => j != null) ?? null)
      : null;
  const autoJudgeModel = autoJudge?.judge_model ?? null;
  const autoRubricId = autoJudge?.rubric_id ?? null;
  useEffect(() => {
    if (autoJudgeModel == null || autoRubricId == null || judgeFired.current) return;
    judgeFired.current = true; // latch BEFORE any await
    void (async () => {
      try {
        const prior = await api.judgments({
          run_id: runId,
          rubric_id: autoRubricId,
          page_size: 1,
        });
        if (!alive.current || prior.length > 0) return;
        const inFlight = (await api.tasks({ limit: 50 })).find(
          (t) =>
            t.type === "judge" &&
            TASK_IN_FLIGHT.has(t.status) &&
            t.result?.run_id === runId,
        );
        if (!alive.current) return;
        if (inFlight) {
          setJudgeTaskId(inFlight.id); // adopt: badge + live subscription
          return;
        }
        await fireJudge(autoJudgeModel, autoRubricId, true);
      } catch {
        // A failed pre-check must not fire blind and must not blank the page
        // — the manual "Judge this evaluation" affordance stays.
      }
    })();
  }, [runId, autoJudgeModel, autoRubricId, fireJudge]);

  const taskId = run?.task_id;
  const terminal = run != null && TERMINAL.has(run.status);
  const judging = judgeTaskId != null;

  // Live fill subscription. Family membership: `task` frames are Task objects
  // — the parent itself (id) or its children (parent_id), for the run's task
  // AND any in-flight judging task; `progress` frames carry the parent's
  // task_id (batch progress = parent ticks, feature-spec.md:107); `judgment`
  // frames join by judgment.run_id (openapi.yaml:1800-1802). Subscribed while
  // the run is live OR judging is in flight; terminal + idle → cleanup aborts.
  useEffect(() => {
    if (!taskId || (terminal && !judging)) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | null = null;
    let stopped = false;
    const refetch = () => {
      timer = null;
      reload();
    };
    void (async () => {
      // Reconnect loop: the page-scoped
      // stream can drop mid-run (connection reuse/proxy/server close) and a
      // single-shot subscription then freezes the fill forever. On a
      // non-abort exit: reconcile immediately (frames emitted while
      // disconnected are gone for good), pause briefly, resubscribe — same
      // philosophy as QueueProvider's reconnect, scoped minimally.
      while (!stopped && !controller.signal.aborted) {
        try {
          for await (const ev of api.taskStream({
            signal: controller.signal,
            // Reconcile on every (re)connect — frames published before the
            // subscription opened (or while disconnected) are gone for good,
            // so a run that finished in that gap would otherwise never
            // refetch (same rule as QueueProvider's onOpen). Same hole for
            // the judging badge: a judge task that went terminal before this
            // subscription opened (or was adopted after it had) emits no
            // further frame, so its status is re-read once per connect rather
            // than leaving "judging…" stuck forever.
            onOpen: () => {
              reload();
              if (judgeTaskId != null) {
                void api
                  .task(judgeTaskId)
                  .then((t) => {
                    if (!TASK_IN_FLIGHT.has(t.status)) {
                      setJudgeTaskId(null);
                      reload();
                    }
                  })
                  .catch(() => {});
              }
            },
          })) {
            let belongs: boolean;
            if (ev.event === "judgment") {
              belongs = ev.data.judgment.run_id === runId;
            } else if (ev.event === "task") {
              belongs =
                ev.data.id === taskId ||
                ev.data.parent_id === taskId ||
                (judgeTaskId != null &&
                  (ev.data.id === judgeTaskId || ev.data.parent_id === judgeTaskId));
              if (
                ev.data.id === judgeTaskId &&
                ev.data.status !== "queued" &&
                ev.data.status !== "running"
              ) {
                // Judging finished — clear the badge and refetch immediately
                // (not debounced: this effect is about to unsubscribe, which
                // would drop a pending timer).
                setJudgeTaskId(null);
                reload();
              }
            } else if (ev.event === "progress") {
              belongs = ev.data.task_id === taskId || ev.data.task_id === judgeTaskId;
            } else {
              belongs = false; // span frames: trace-view scope
            }
            if (!belongs) continue;
            if (ev.event === "progress" && ev.data.progress.stage) {
              setStage(ev.data.progress.stage);
            }
            // Trailing debounce: first event schedules the refetch, bursts
            // within the window coalesce into that one GET.
            if (timer == null && !stopped) timer = setTimeout(refetch, REFETCH_DEBOUNCE_MS);
          }
        } catch {
          // Aborted on unmount/terminal, or stream errored — the loop guard
          // below decides between exit and reconnect.
        }
        if (stopped || controller.signal.aborted) return;
        reload();
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    })();
    return () => {
      stopped = true;
      controller.abort();
      if (timer != null) clearTimeout(timer);
    };
  }, [taskId, terminal, judging, judgeTaskId, runId, reload]);

  const cancel = async () => {
    if (!run) return;
    setCancelling(true);
    try {
      await api.cancelTask(run.task_id);
      reload();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setCancelling(false);
    }
  };

  // The grid's cells are memoized on their content (ComparisonView.sameCell),
  // which only holds while these two slots keep their identity across the
  // ~300 ms refetch cycle — inline arrows made every cell re-render and
  // re-parse its markdown three times a second (docs/review-2026-08-05.md A6).
  // Both close over nothing but stable setters and `navigate`.
  const renderAnnotation = useCallback(
    (cell: RunCell, ctx: CellContext) =>
      cell.latest_score != null ? (
        <ScoreChip
          score={cell.latest_score}
          testId={`score-chip-${ctx.rowIndex}-${ctx.columnIndex}`}
          onClick={cell.case_id != null ? () => setDrawerCaseId(cell.case_id!) : undefined}
        />
      ) : null,
    [],
  );

  const renderCellAction = useCallback(
    (cell: RunCell, ctx: CellContext) => (
      <Group justify="space-between" mt={2} wrap="nowrap">
        {cell.conversation_id ? (
          <Anchor
            size="xs"
            data-testid={`open-in-chat-${ctx.rowIndex}-${ctx.columnIndex}`}
            onClick={() => navigate(`/chat/${cell.conversation_id}`)}
          >
            Open in Chat ↗
          </Anchor>
        ) : (
          <span />
        )}
        <Group gap={2} wrap="nowrap">
          {/* ⌁ — "⌁ trace icon on every turn — in Chat, results
              grid cells, and drill-in. Works on originals, forks, and
              replays alike" (feature-spec.md:145): done cells that carry
              the produced turn's id (RunCell.turn_id, openapi.yaml:1652)
              route to its trace — the baseline cell to the original
              turn's, endpoint cells to the fork replays'. */}
          {cell.turn_id && (
            <ActionIcon
              size="xs"
              variant="subtle"
              color="gray"
              aria-label={`Open trace for turn ${cell.turn_id}`}
              onClick={() => navigate(`/trace/${cell.turn_id}`)}
            >
              ⌁
            </ActionIcon>
          )}
          <ActionIcon
            size="xs"
            variant="subtle"
            color="gray"
            aria-label={`Re-run turn ${ctx.source.turn_id} with…`}
            onClick={() => setForkSource(ctx.source)}
          >
            ⑂
          </ActionIcon>
        </Group>
      </Group>
    ),
    [navigate],
  );

  if (error ?? loadError) {
    return (
      <Alert color="red" title="Error" m="md" maw={640}>
        {error ?? loadError?.message}
      </Alert>
    );
  }
  if (!run) {
    return <Loader size="sm" mx="auto" my="xl" display="block" />;
  }

  const rubricName = (id: string) => rubrics.find((r) => r.id === id)?.name ?? id;

  return (
    <Stack gap="sm" p="md">
      <Group justify="space-between">
        <Group gap="xs">
          <Anchor size="xs" onClick={() => navigate("/evaluations")}>
            ‹ Evaluations
          </Anchor>
          <Title order={4}>Evaluation {run.id}</Title>
          <Badge size="sm" variant="light" color={STATUS_COLOR[run.status]}>
            {run.status}
          </Badge>
          {judging && (
            <Badge size="sm" variant="light" color="grape" data-testid="judging-badge">
              judging…
            </Badge>
          )}
          {stage != null && !terminal && (
            <Text size="xs" c="dimmed" data-testid="run-stage">
              {stage}
            </Text>
          )}
        </Group>
        <Group gap="xs">
          {/* "'Score this run' on any finished run" (feature-spec.md:61) —
              after-the-fact judging via the same POST /eval/judge. */}
          {run.status === "done" && !judging && (
            <Button
              size="compact-xs"
              variant="light"
              onClick={() => setJudgeFormOpen((o) => !o)}
            >
              ⚖ Judge this evaluation
            </Button>
          )}
          {(run.status === "queued" || run.status === "running") && (
            <Button
              size="compact-xs"
              variant="light"
              color="red"
              loading={cancelling}
              onClick={() => void cancel()}
            >
              Cancel
            </Button>
          )}
        </Group>
      </Group>

      {judgeFormOpen && (
        <Paper withBorder p="sm" maw={480} data-testid="judge-form">
          <Group grow>
            <Select
              size="xs"
              label="Judge model"
              placeholder="Judge model"
              data={(models ?? []).map((m) => ({ value: m.id, label: m.name }))}
              value={judgeDraft.judge_model ?? null}
              onChange={(v) => setJudgeDraft((d) => ({ ...d, judge_model: v ?? undefined }))}
            />
            <Select
              size="xs"
              label="Rubric"
              placeholder="Rubric"
              data={rubrics.map((r) => ({ value: r.id, label: `${r.name} v${r.version}` }))}
              value={judgeDraft.rubric_id ?? null}
              onChange={(v) => setJudgeDraft((d) => ({ ...d, rubric_id: v ?? undefined }))}
            />
          </Group>
          <Group justify="flex-end" mt="xs">
            <Button
              size="compact-xs"
              disabled={!judgeDraft.judge_model || !judgeDraft.rubric_id}
              onClick={() => {
                setJudgeFormOpen(false);
                void fireJudge(judgeDraft.judge_model!, judgeDraft.rubric_id!);
              }}
            >
              Judge
            </Button>
          </Group>
        </Paper>
      )}

      {/* Summary header — "summary header (mean, distribution sparkline)"
          (feature-spec.md:49), per rubric (RunScoreSummary.rubrics,
          openapi.yaml:1915-1928). Distribution = tiny inline CSS bars over the
          bucketed counts — deliberately no chart lib. */}
      {summary != null && summary.rubrics.length > 0 && (
        <Group gap="xl" data-testid="run-summary">
          {summary.rubrics.map((r) => {
            const max = Math.max(...r.distribution, 1);
            return (
              <Group key={`${r.rubric_id}-v${r.rubric_version}`} gap={8} wrap="nowrap">
                <Text size="xs" fw={600}>
                  {rubricName(r.rubric_id)} v{r.rubric_version}
                </Text>
                <Text size="xs" c="dimmed">
                  mean {r.mean.toFixed(2)} · n={r.count}
                </Text>
                <Group
                  gap={2}
                  align="flex-end"
                  h={16}
                  data-testid={`dist-${r.rubric_id}-v${r.rubric_version}`}
                >
                  {r.distribution.map((n, i) => (
                    <Box
                      key={i}
                      w={5}
                      h={2 + (n / max) * 14}
                      bg={n > 0 ? "blue.4" : "gray.3"}
                      style={{ borderRadius: 1 }}
                    />
                  ))}
                </Group>
              </Group>
            );
          })}
        </Group>
      )}

      {/* Cell ⑂ via the cell-action slot (separate from renderAnnotation,
          which now fills with score chips). Done cells only — the slot
          is invoked for status done; every row carries its source turn
          (Run.rows[].source, openapi.yaml:1607-1643). Sketch 04: "+ Re-run
          this turn with… POST …/replay/turn".

          Fork pivot: for turn re-fire runs the server already delivers
          the pivoted grid — one row, "column per endpoint" with endpoint-name
          labels (openapi.yaml:636-639; mock/main.py:634-635) — so no client
          reshaping is needed; ComparisonView renders whatever columns arrive.
          The added affordance is "Open in Chat ↗" on any cell that carries a
          conversation_id ("'Open in Chat' button on every results cell",
          feature-spec.md:70; annotated sketch 04 shows it in the cell footer):
          endpoint cells carry the FORK holding the result
          (RunCell.conversation_id, openapi.yaml:1651) and the baseline cell
          carries the ORIGINAL conversation + turn (mock/main.py:643-646), so
          one rule links baseline → original and forks → their conversations.
          Cells without a conversation_id (plain replay configs) get no link.

          Score chips: "score column reads latest judgment per (case,
          rubric)" (feature-spec.md:62) — the server denormalizes that into
          RunCell.latest_score, joined to its case by RunCell.case_id
          (openapi.yaml:1654-1664); chip tap opens the judgment drawer. */}
      <ComparisonView
        run={run}
        renderAnnotation={renderAnnotation}
        renderCellAction={renderCellAction}
      />
      {forkSource && (
        <ForkModal
          conversationId={forkSource.conversation_id}
          turnId={forkSource.turn_id}
          opened
          onClose={() => setForkSource(null)}
        />
      )}
      {drawerCaseId != null && (
        <JudgmentDrawer
          caseId={drawerCaseId}
          rubrics={rubrics}
          opened
          onClose={() => setDrawerCaseId(null)}
        />
      )}
    </Stack>
  );
}
