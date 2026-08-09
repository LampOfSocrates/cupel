import { useState, type ReactNode } from "react";
import {
  ActionIcon,
  Badge,
  Button,
  Group,
  Progress,
  Stack,
  Text,
  UnstyledButton,
} from "@mantine/core";
import type { Task } from "../api/types";
import { STATUS_COLOR } from "./status";

// Queue panel (feature-spec.md:106): "each task shows live progress bar +
// stage text + elapsed time; expandable to child tasks; cancel (parent
// cancels children). Failed children don't kill the batch — shown as partial
// failure with retry-failed button." Task model: openapi.yaml:1726-1773.
//
// Data flow: pure render of the Task[] prop — SSE/polling and the actual
// DELETE /tasks/{id} + POST /tasks/{id}/retry-failed wiring live in the page;
// this component only emits the callbacks. `onExpand` fires when a row is
// expanded so the page can lazy-fetch children ("Populated on GET /tasks/{id}",
// openapi.yaml:1760); embedded `children` render when present.

const TYPE_LABEL: Record<Task["type"], string> = {
  chat: "Chat",
  replay: "Replay",
  replay_turn: "Turn fork",
  judge: "Judging",
  // Additive in contract v0.3.0 (openapi.yaml:2770-2782): compact = memory
  // compaction, import = a large POST /eval/cases/import running in
  // the background.
  compact: "Compaction",
  import: "Import",
};

// Sketch 05 elapsed format: "2m14s".
export function formatElapsed(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m${String(seconds % 60).padStart(2, "0")}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h${String(minutes % 60).padStart(2, "0")}m`;
}

function elapsed(task: Task, now: number): string | null {
  const from = task.started_at ?? task.created_at;
  if (task.status === "queued") return null;
  const to = task.finished_at ? new Date(task.finished_at).getTime() : now;
  return formatElapsed(to - new Date(from).getTime());
}

const active = (t: Task) => t.status === "queued" || t.status === "running";

interface Props {
  tasks: Task[];
  onCancel?: (taskId: string) => void;
  onRetryFailed?: (taskId: string) => void;
  /** Fired when a parent row expands — lets the page lazy-fetch children. */
  onExpand?: (taskId: string) => void;
  /**
   * Result deep links per task — "View results" → grid, "Open in Chat" →
   * fork (Task.result, openapi.yaml:1744-1752; sketch 05). A prop so routing
   * stays in the page and this component remains a pure render.
   */
  renderResult?: (task: Task) => ReactNode;
  /** Clock for elapsed time; injectable for deterministic tests. */
  now?: number;
}

export function TaskQueue({
  tasks,
  onCancel,
  onRetryFailed,
  onExpand,
  renderResult,
  // Suppressed, not a defect: elapsed time is wall-clock by definition, every
  // caller that needs determinism passes `now` (the tests do), and the value is
  // only ever rendered as "x ago". The default parameter IS that seam.
  // eslint-disable-next-line react-hooks/purity
  now = Date.now(),
}: Props) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const toggle = (id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else {
        next.add(id);
        onExpand?.(id);
      }
      return next;
    });
  };

  if (tasks.length === 0) {
    return (
      <Text size="xs" c="dimmed" ta="center" my="sm">
        No tasks
      </Text>
    );
  }

  return (
    <Stack gap="sm">
      {tasks.map((task) => {
        const { done, total, stage } = task.progress;
        const failedChildren = (task.children ?? []).filter((c) => c.status === "failed");
        // Partial failure (feature-spec.md:106) — retry-failed applies when
        // the batch has failed children or the task itself failed.
        const retryable = failedChildren.length > 0 || task.status === "failed";
        const time = elapsed(task, now);
        return (
          <div key={task.id} data-testid={`task-${task.id}`}>
            <Group gap={6} wrap="nowrap">
              <UnstyledButton
                onClick={() => toggle(task.id)}
                style={{ flex: 1, minWidth: 0 }}
                aria-label={`Toggle children of ${TYPE_LABEL[task.type]}`}
              >
                <Group justify="space-between" wrap="nowrap" gap={4}>
                  <Text size="xs" fw={600} truncate>
                    {TYPE_LABEL[task.type]}
                  </Text>
                  <Group gap={6} wrap="nowrap">
                    <Text size="xs" c="dimmed" style={{ whiteSpace: "nowrap" }}>
                      {total > 0 ? `${done}/${total}` : ""}
                      {time ? ` · ${time}` : ""}
                    </Text>
                    <Badge size="xs" variant="light" color={STATUS_COLOR[task.status]}>
                      {task.status}
                    </Badge>
                  </Group>
                </Group>
              </UnstyledButton>
              {active(task) && onCancel && (
                <ActionIcon
                  size="sm"
                  variant="subtle"
                  color="gray"
                  aria-label={`Cancel ${TYPE_LABEL[task.type]}`}
                  onClick={() => onCancel(task.id)}
                >
                  ✕
                </ActionIcon>
              )}
            </Group>
            <Progress
              size="xs"
              mt={4}
              value={total > 0 ? (done / total) * 100 : task.status === "done" ? 100 : 0}
              color={STATUS_COLOR[task.status]}
              animated={task.status === "running"}
            />
            <Group justify="space-between" mt={2} wrap="nowrap">
              <Text size="xs" c="dimmed" truncate>
                {stage ?? ""}
              </Text>
              {retryable && onRetryFailed && (
                <Button
                  size="compact-xs"
                  variant="subtle"
                  color="red"
                  onClick={() => onRetryFailed(task.id)}
                >
                  Retry failed
                </Button>
              )}
            </Group>
            {task.error && (
              <Text size="xs" c="red">
                {task.error}
              </Text>
            )}
            {renderResult?.(task)}
            {expanded.has(task.id) && (task.children?.length ?? 0) > 0 && (
              <Stack gap={2} ml="md" mt={4} data-testid={`children-${task.id}`}>
                {task.children!.map((child) => (
                  <Group key={child.id} justify="space-between" wrap="nowrap" gap={4}>
                    <Text size="xs" truncate>
                      {child.progress.stage ?? TYPE_LABEL[child.type]}
                    </Text>
                    <Group gap={6} wrap="nowrap">
                      {renderResult?.(child)}
                      <Badge size="xs" variant="light" color={STATUS_COLOR[child.status]}>
                        {child.status}
                      </Badge>
                    </Group>
                  </Group>
                ))}
              </Stack>
            )}
          </div>
        );
      })}
    </Stack>
  );
}
