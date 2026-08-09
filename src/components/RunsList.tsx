import { Anchor, Badge, Group, Text, UnstyledButton } from "@mantine/core";
import type { RunSummaryItem } from "../api/types";
import { relativeTime } from "../lib/relativeTime";
import { STATUS_COLOR } from "./status";

// Runs listing — RunSummaryItem rows (openapi.yaml:1596-1605: id, tree_id,
// status, created_at, task_id, label). Pure render: row click and task link
// are callbacks; navigation/fetching belongs to the pages.

interface Props {
  runs: RunSummaryItem[];
  onOpen?: (run: RunSummaryItem) => void;
  /** Task link per row — deep link into the queue panel (sketch 05). */
  onTaskClick?: (taskId: string) => void;
}

export function RunsList({ runs, onOpen, onTaskClick }: Props) {
  if (runs.length === 0) {
    return (
      <Text size="xs" c="dimmed" ta="center" my="sm">
        No evaluations yet
      </Text>
    );
  }
  return (
    <div>
      {runs.map((run) => (
        <Group key={run.id} gap={6} wrap="nowrap" data-testid={`run-${run.id}`}>
          <UnstyledButton
            onClick={() => onOpen?.(run)}
            px={6}
            py={4}
            style={{ flex: 1, minWidth: 0 }}
            aria-label={`Open ${run.label ?? `Evaluation ${run.id}`}`}
          >
            <Group justify="space-between" wrap="nowrap" gap={6}>
              <Group gap={6} wrap="nowrap" style={{ minWidth: 0 }}>
                <Badge size="xs" variant="light" color={STATUS_COLOR[run.status]}>
                  {run.status}
                </Badge>
                <Text size="xs" truncate>
                  {run.label ?? `Evaluation ${run.id}`}
                </Text>
              </Group>
              <Text size="xs" c="dimmed" style={{ whiteSpace: "nowrap" }}>
                {relativeTime(run.created_at)}
              </Text>
            </Group>
          </UnstyledButton>
          {onTaskClick && (
            <Anchor
              component="button"
              size="xs"
              aria-label={`Task for ${run.label ?? `Evaluation ${run.id}`}`}
              onClick={() => onTaskClick(run.task_id)}
            >
              task
            </Anchor>
          )}
        </Group>
      ))}
    </div>
  );
}
