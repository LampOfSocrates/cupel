import { NavLink as RouterNavLink, useNavigate } from "react-router";
import { AppShell, Button, Divider, NavLink, Stack, Text } from "@mantine/core";
import { useApp } from "../AppContext";
import { ConversationList } from "./ConversationList";

// Nav entries exist as routes with placeholder pages; later tasks fill them
// (Runs P1-T11, Queue P1-T08, Agents P1-T10). Chat carries the recent list
// (feature-spec.md:5 "Expanded sidebar shows recent conversations under Chat").
const NAV = [
  { to: "/chat", label: "Chat" },
  { to: "/runs", label: "Runs" },
  { to: "/queue", label: "Queue" },
  { to: "/agents", label: "Agents" },
];

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
