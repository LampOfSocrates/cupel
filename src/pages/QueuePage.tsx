import { Anchor, Group, Stack, Text, Title } from "@mantine/core";
import { Link } from "react-router";
import type { Task } from "../api/types";
import { TaskQueue } from "../components";
import { useQueue } from "../QueueContext";

// P1-T08 — the full queue panel per sketch 05 ("Tasks" header, "3 running ·
// SSE live", parent cards with children). "Queue panel (all pages): each task
// shows live progress bar + stage text + elapsed time; expandable to child
// tasks; cancel (parent cancels children). Failed children don't kill the
// batch — shown as partial failure with retry-failed button"
// (feature-spec.md:110). All data/actions come from QueueProvider (one
// app-wide stream); TaskQueue stays a pure render.

// Result deep links (Task.result, openapi.yaml:1744-1752): "'View results'
// to the grid, 'Open in Chat' to the fork". Routes: /runs/:runId (App.tsx),
// /chat/:conversationId (App.tsx).
function resultLinks(task: Task) {
  const links = [];
  if (task.result?.run_id) {
    links.push(
      <Anchor key="run" component={Link} to={`/runs/${task.result.run_id}`} size="xs">
        View results ↗
      </Anchor>,
    );
  }
  if (task.result?.conversation_id) {
    links.push(
      <Anchor
        key="conv"
        component={Link}
        to={`/chat/${task.result.conversation_id}`}
        size="xs"
      >
        Open in Chat ↗
      </Anchor>,
    );
  }
  return links.length > 0 ? <Group gap="sm">{links}</Group> : null;
}

export function QueuePage() {
  const { tasks, loadChildren, cancel, retryFailed } = useQueue();
  const runningCount = tasks.filter((t) => t.status === "running").length;

  return (
    <Stack gap="sm" maw={640}>
      <Group justify="space-between" align="baseline">
        <Title order={3}>Tasks</Title>
        {/* Sketch 05 header: "3 running · SSE live" */}
        <Text size="xs" c="dimmed">
          {runningCount} running · SSE live
        </Text>
      </Group>
      <TaskQueue
        tasks={tasks}
        onCancel={(id) => void cancel(id)}
        onRetryFailed={(id) => void retryFailed(id)}
        onExpand={(id) => void loadChildren(id)}
        renderResult={resultLinks}
      />
    </Stack>
  );
}
