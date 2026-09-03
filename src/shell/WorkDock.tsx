import { useEffect, useState } from "react";
import { ActionIcon, Box, Group, Progress, ScrollArea, Text, Tooltip } from "@mantine/core";
import { IconX } from "@tabler/icons-react";
import { Link } from "react-router";
import type { Task } from "../api/types";
import { useQueue } from "../QueueContext";
import { etaLabel } from "./workEta";

/** Handoff: "A docked, collapsible Work queue sits at the bottom of both modes". */
const DOCK_MAX_HEIGHT = 190;

// A task's label. The contract gives a type and a progress stage, not a
// sentence, so the sentence is built here — one place, so the dock and any
// future queue row cannot describe the same task differently.
const TYPE_LABEL: Record<Task["type"], string> = {
  chat: "Chat reply",
  replay: "Replay",
  replay_turn: "Turn re-fire",
  judge: "Judging",
  compact: "Memory compaction",
  import: "Case import",
};

function WorkRow({ task, now }: { task: Task; now: number }) {
  const { cancel } = useQueue();
  const { done, total } = task.progress;
  const pct = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0;
  const cancellable = task.status === "queued" || task.status === "running";

  return (
    <Group gap={10} wrap="nowrap" px={16} py={6} style={{ minWidth: 0 }}>
      <Text fz="sm" style={{ flex: "0 1 220px", minWidth: 0 }} truncate>
        {TYPE_LABEL[task.type]}
        {total > 1 && (
          <Text component="span" ff="monospace" fz="xs" c="gray.5">
            {" "}
            {done}/{total}
          </Text>
        )}
      </Text>

      {/* "a determinate progress bar (#185FA5 fill on #E4E2DA track)" — the
          queue is about knowing how far along something is, so an
          indeterminate bar would defeat the row. */}
      <Progress
        value={pct}
        size={4}
        radius="xs"
        color="accent.6"
        bg="gray.3"
        style={{ flex: 1, minWidth: 80 }}
        aria-label={`${TYPE_LABEL[task.type]} ${pct}% complete`}
      />

      <Text ff="monospace" fz="xs" c="gray.6" style={{ flex: "0 0 auto" }}>
        {etaLabel(task, now)}
      </Text>

      {cancellable ? (
        <Tooltip label="Cancel" openDelay={400}>
          <ActionIcon
            size="xs"
            variant="subtle"
            c="gray.5"
            aria-label={`Cancel ${TYPE_LABEL[task.type]}`}
            onClick={() => void cancel(task.id)}
            styles={{ root: { "&:hover": { color: "var(--mantine-color-danger-7)" } } }}
          >
            <IconX size={12} />
          </ActionIcon>
        </Tooltip>
      ) : (
        <Box w={22} />
      )}
    </Group>
  );
}

/**
 * The docked Work queue — runs in flight, without leaving the screen you are on.
 *
 * Shows the ACTIVE tasks only. The dock answers "is my run moving?"; the full
 * history, with its finished and failed rows and their results, is what /queue
 * is for, and the footer links there rather than duplicating it here.
 */
export function WorkDock({ onClose }: { onClose: () => void }) {
  const { tasks, total } = useQueue();
  const active = tasks.filter((t) => t.status === "queued" || t.status === "running");

  // One clock for every row, ticking only while the dock is open — an ETA that
  // never refreshes is a stale promise, and a per-row timer would be N timers
  // for one shared value.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  return (
    <Box
      id="cupel-work-dock"
      data-testid="work-dock"
      bg="white"
      style={{ borderTop: "1px solid var(--mantine-color-gray-4)" }}
    >
      <Group
        px={16}
        py={6}
        gap="sm"
        justify="space-between"
        wrap="nowrap"
        bg="gray.2"
        style={{ borderBottom: "1px solid var(--mantine-color-gray-3)" }}
      >
        <Text fz="xs" fw={600} c="gray.6" style={{ letterSpacing: "0.05em" }}>
          WORK
        </Text>
        <Group gap={12} wrap="nowrap">
          <Text component={Link} to="/queue" fz="xs" c="gray.6" td="underline">
            Full queue{total > 0 ? ` (${total})` : ""}
          </Text>
          <ActionIcon size="xs" variant="subtle" c="gray.5" aria-label="Close work queue" onClick={onClose}>
            <IconX size={12} />
          </ActionIcon>
        </Group>
      </Group>

      {active.length === 0 ? (
        // "Empty states: written as real sentences that explain what to do."
        <Text fz="sm" c="gray.6" px={16} py={10}>
          Nothing running. Replays, judging and imports show their progress here while they work.
        </Text>
      ) : (
        <ScrollArea.Autosize mah={DOCK_MAX_HEIGHT}>
          {active.map((task) => (
            <WorkRow key={task.id} task={task} now={now} />
          ))}
        </ScrollArea.Autosize>
      )}
    </Box>
  );
}
