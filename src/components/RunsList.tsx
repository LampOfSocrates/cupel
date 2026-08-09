import { Anchor, Badge, Group, Text, UnstyledButton } from "@mantine/core";
import type { EvaluationSummaryItem } from "../api/types";
import { relativeTime } from "../lib/relativeTime";
import { STATUS_COLOR } from "./status";

// Evaluations listing — EvaluationSummaryItem rows (openapi.yaml:1596-1605: id, tree_id,
// status, created_at, task_id, label). Pure render: row click and task link
// are callbacks; navigation/fetching belongs to the pages.

interface Props {
  evaluations: EvaluationSummaryItem[];
  onOpen?: (evaluation: EvaluationSummaryItem) => void;
  /** Task link per row — deep link into the queue panel (sketch 05). */
  onTaskClick?: (taskId: string) => void;
}

export function RunsList({ evaluations, onOpen, onTaskClick }: Props) {
  if (evaluations.length === 0) {
    return (
      <Text size="xs" c="dimmed" ta="center" my="sm">
        No evaluations yet
      </Text>
    );
  }
  return (
    <div>
      {evaluations.map((evaluation) => (
        <Group key={evaluation.id} gap={6} wrap="nowrap" data-testid={`evaluation-${evaluation.id}`}>
          <UnstyledButton
            onClick={() => onOpen?.(evaluation)}
            px={6}
            py={4}
            style={{ flex: 1, minWidth: 0 }}
            aria-label={`Open ${evaluation.label ?? `Evaluation ${evaluation.id}`}`}
          >
            <Group justify="space-between" wrap="nowrap" gap={6}>
              <Group gap={6} wrap="nowrap" style={{ minWidth: 0 }}>
                <Badge size="xs" variant="light" color={STATUS_COLOR[evaluation.status]}>
                  {evaluation.status}
                </Badge>
                <Text size="xs" truncate>
                  {evaluation.label ?? `Evaluation ${evaluation.id}`}
                </Text>
              </Group>
              <Text size="xs" c="dimmed" style={{ whiteSpace: "nowrap" }}>
                {relativeTime(evaluation.created_at)}
              </Text>
            </Group>
          </UnstyledButton>
          {onTaskClick && (
            <Anchor
              component="button"
              size="xs"
              aria-label={`Task for ${evaluation.label ?? `Evaluation ${evaluation.id}`}`}
              onClick={() => onTaskClick(evaluation.task_id)}
            >
              task
            </Anchor>
          )}
        </Group>
      ))}
    </div>
  );
}
