import { useCallback, useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router";
import {
  ActionIcon,
  Alert,
  Anchor,
  Badge,
  Button,
  Group,
  Loader,
  Stack,
  Text,
  Title,
} from "@mantine/core";
import { api } from "../api/client";
import type { Run } from "../api/types";
import { ComparisonView, ForkModal, STATUS_COLOR } from "../components";
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
// Cancel = DELETE /tasks/{task_id} on the run's parent task (openapi.yaml:
// 832-839 "Cancel a task … cancels queued/running children") — a small
// affordance only; the queue PANEL is P1-T08.

const TERMINAL = new Set<Run["status"]>(["done", "failed", "cancelled"]);
const REFETCH_DEBOUNCE_MS = 300;

export function RunDetailPage() {
  const { tree } = useApp();
  const { runId = "" } = useParams();
  const navigate = useNavigate();

  const [run, setRun] = useState<Run | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Latest progress stage text off the stream ("Conversation 3/10 · turn 2/6",
  // openapi.yaml:791-792; feature-spec.md:109).
  const [stage, setStage] = useState<string | null>(null);
  const [cancelling, setCancelling] = useState(false);
  // P1-T13 cell re-fire target — the ⑂ modal is seeded with the CELL's source
  // turn (feature-spec.md:72 "'re-run this turn with…' on any results cell").
  const [forkSource, setForkSource] = useState<{
    conversation_id: string;
    turn_id: string;
  } | null>(null);

  const load = useCallback(async () => {
    try {
      setRun(await api.run(tree, runId));
    } catch (e) {
      setError((e as Error).message);
    }
  }, [tree, runId]);

  useEffect(() => {
    setRun(null);
    setError(null);
    setStage(null);
    void load();
  }, [load]);

  const taskId = run?.task_id;
  const terminal = run != null && TERMINAL.has(run.status);

  // Live fill subscription. Family membership: `task` frames are Task objects
  // — the parent itself (id) or its children (parent_id); `progress` frames
  // carry the parent's task_id (batch progress = parent ticks,
  // feature-spec.md:107). Terminal status flips `terminal` → cleanup aborts.
  useEffect(() => {
    if (!taskId || terminal) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | null = null;
    let stopped = false;
    const refetch = () => {
      timer = null;
      void load();
    };
    void (async () => {
      try {
        for await (const ev of api.taskStream({ signal: controller.signal })) {
          const belongs =
            ev.event === "task"
              ? ev.data.id === taskId || ev.data.parent_id === taskId
              : ev.data.task_id === taskId;
          if (!belongs) continue;
          if (ev.event === "progress" && ev.data.progress.stage) {
            setStage(ev.data.progress.stage);
          }
          // Trailing debounce: first event schedules the refetch, bursts
          // within the window coalesce into that one GET.
          if (timer == null && !stopped) timer = setTimeout(refetch, REFETCH_DEBOUNCE_MS);
        }
      } catch {
        // Aborted on unmount/terminal, or stream dropped — the polling
        // fallback (feature-spec.md:108) is queue-panel scope (P1-T08).
      }
    })();
    return () => {
      stopped = true;
      controller.abort();
      if (timer != null) clearTimeout(timer);
    };
  }, [taskId, terminal, load]);

  const cancel = async () => {
    if (!run) return;
    setCancelling(true);
    try {
      await api.cancelTask(run.task_id);
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setCancelling(false);
    }
  };

  if (error) {
    return (
      <Alert color="red" title="Error" m="md" maw={640}>
        {error}
      </Alert>
    );
  }
  if (!run) {
    return <Loader size="sm" mx="auto" my="xl" display="block" />;
  }

  return (
    <Stack gap="sm" p="md">
      <Group justify="space-between">
        <Group gap="xs">
          <Anchor size="xs" onClick={() => navigate("/runs")}>
            ‹ Runs
          </Anchor>
          <Title order={4}>Run {run.id}</Title>
          <Badge size="sm" variant="light" color={STATUS_COLOR[run.status]}>
            {run.status}
          </Badge>
          {stage != null && !terminal && (
            <Text size="xs" c="dimmed" data-testid="run-stage">
              {stage}
            </Text>
          )}
        </Group>
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
      {/* Cell ⑂ via the cell-action slot (separate from renderAnnotation,
          which is reserved for T12b score badges). Done cells only — the slot
          is invoked for status done; every row carries its source turn
          (Run.rows[].source, openapi.yaml:1607-1643). Sketch 04: "+ Re-run
          this turn with… POST …/replay/turn".

          P1-T14 fork pivot: for turn re-fire runs the server already delivers
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
          Cells without a conversation_id (plain replay configs) get no link. */}
      <ComparisonView
        run={run}
        renderCellAction={(cell, ctx) => (
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
        )}
      />
      {forkSource && (
        <ForkModal
          conversationId={forkSource.conversation_id}
          turnId={forkSource.turn_id}
          opened
          onClose={() => setForkSource(null)}
        />
      )}
    </Stack>
  );
}
