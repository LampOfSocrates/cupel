import { Box, Group, Loader, Text, UnstyledButton } from "@mantine/core";
import { useLocation } from "react-router";
import { useQueue } from "../QueueContext";
import { usePageHeaderValue } from "./PageHeaderContext";
import { routeTitle } from "./routeTitle";

/** Handoff: "Top bar (36px-ish, padding:8px 16px …)". */
export const TOP_BAR_HEIGHT = 36;

/**
 * Count badge — "background #E6F1FB, color #185FA5, 10px mono, 600,
 * padding:1px 6px, border-radius:8px". The same badge the sidebar's nav
 * entries use, which is why it is a shape rather than a one-off.
 */
function CountBadge({ value }: { value: number }) {
  return (
    <Box
      component="span"
      ff="monospace"
      fz="xs"
      fw={600}
      c="accent.6"
      bg="accent.1"
      style={{ padding: "1px 6px", borderRadius: 8, lineHeight: 1.4 }}
    >
      {value}
    </Box>
  );
}

/**
 * The page's name, and the way into the Work queue.
 *
 * The Work control is a TOGGLE for the docked queue (src/shell/WorkDock.tsx),
 * not a link to /queue: the handoff's queue is a dock you open over whatever
 * you were doing, so that checking on a run never costs you the screen you
 * were on. /queue remains a real route for a full-page view and a bookmark.
 */
export function TopBar({ workOpen, onToggleWork }: { workOpen: boolean; onToggleWork: () => void }) {
  const { pathname } = useLocation();
  const claimed = usePageHeaderValue();
  const fallback = routeTitle(pathname);
  const title = claimed?.title ?? fallback.title;
  const subtitle = claimed ? claimed.subtitle : fallback.subtitle;

  const { pendingCount, running } = useQueue();

  return (
    <Group
      h={TOP_BAR_HEIGHT}
      px={16}
      py={8}
      gap="sm"
      wrap="nowrap"
      justify="space-between"
      bg="white"
      style={{ borderBottom: "1px solid var(--mantine-color-gray-3)" }}
    >
      <Group gap={8} wrap="nowrap" style={{ minWidth: 0 }}>
        {/* The page's h1. It is the only place the page is named now, so it
            has to carry the heading role rather than merely look like one —
            a screen reader's "what page am I on" lands here. */}
        <Text component="h1" fz="lg" fw={600} m={0} truncate>
          {title}
        </Text>
        {subtitle && (
          <Text fz="sm" c="gray.6" truncate>
            {subtitle}
          </Text>
        )}
      </Group>

      <UnstyledButton
        onClick={onToggleWork}
        aria-expanded={workOpen}
        aria-controls="cupel-work-dock"
        data-testid="work-toggle"
        style={{
          border: "1px solid var(--mantine-color-gray-4)",
          borderRadius: 6,
          padding: "4px 8px",
          background: workOpen ? "var(--mantine-color-accent-0)" : "transparent",
          flexShrink: 0,
        }}
      >
        <Group gap={6} wrap="nowrap">
          {/* "a spinner glyph that rotates while runs are active" — present
              only while something is actually running, so a still queue is
              visibly still rather than permanently pretending to work. */}
          {running && <Loader size={11} aria-label="Runs active" />}
          <Text fz="sm" fw={500}>
            Work
          </Text>
          {pendingCount > 0 && <CountBadge value={pendingCount} />}
        </Group>
      </UnstyledButton>
    </Group>
  );
}
