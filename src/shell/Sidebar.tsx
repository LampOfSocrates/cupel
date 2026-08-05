import { NavLink as RouterNavLink, useNavigate } from "react-router";
import { AppShell, Badge, Button, Divider, Group, Loader, NavLink, Stack, Text } from "@mantine/core";
import { useApp } from "../AppContext";
import { useQueue } from "../QueueContext";
import { ConversationList } from "./ConversationList";

// Nav entries: Chat carries the recent list (feature-spec.md:5 "Expanded
// sidebar shows recent conversations under Chat"); Queue carries the pending
// badge + running spinner (feature-spec.md:111, P1-T08).
const NAV = [
  { to: "/chat", label: "Chat" },
  { to: "/runs", label: "Runs" },
  { to: "/queue", label: "Queue" },
  { to: "/agents", label: "Agents" },
];

// P1-T08 badge on the Queue entry: "Sidebar badge: pending count; subtle
// spinner while anything is running" (feature-spec.md:111) — pending =
// queued + running parents, fed by QueueProvider's app-wide stream.
function QueueIndicator() {
  const { pendingCount, running } = useQueue();
  if (pendingCount === 0 && !running) return null;
  return (
    <Group gap={6} wrap="nowrap">
      {running && <Loader size={12} aria-label="Tasks running" />}
      {pendingCount > 0 && (
        <Badge size="xs" variant="light" data-testid="queue-badge">
          {pendingCount}
        </Badge>
      )}
    </Group>
  );
}

export function Sidebar() {
  const { tree } = useApp();
  const navigate = useNavigate();

  return (
    <>
      <AppShell.Section>
        <Stack gap={4}>
          {/* New chat button at top (feature-spec.md:5); posting the first
              message is P1-T02 — for now it opens the empty chat page. */}
          <Button variant="default" size="xs" onClick={() => navigate("/chat")}>
            + New chat
          </Button>
          {NAV.map((item) => (
            <NavLink
              key={item.to}
              component={RouterNavLink}
              to={item.to}
              label={item.label}
              rightSection={item.to === "/queue" ? <QueueIndicator /> : undefined}
            />
          ))}
        </Stack>
        <Divider my="xs" />
        <Text size="xs" c="dimmed" fw={600} tt="uppercase" px={4}>
          {tree} · Recent
        </Text>
      </AppShell.Section>
      <AppShell.Section grow style={{ overflowY: "auto" }} mt={4}>
        <ConversationList tree={tree} />
      </AppShell.Section>
    </>
  );
}
