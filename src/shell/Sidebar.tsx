import { Fragment } from "react";
import { NavLink as RouterNavLink, useNavigate } from "react-router";
import { AppShell, Badge, Button, Divider, Group, Loader, NavLink, Stack, Text } from "@mantine/core";
import { api } from "../api/client";
import { clearAuthToken, useAuthToken } from "../api/auth";
import { useApp } from "../AppContext";
import { useQueue } from "../QueueContext";
import { ConversationList } from "./ConversationList";

// Nav entries: Chat carries the recent list (feature-spec.md:5 "Expanded
// sidebar shows recent conversations under Chat"); Queue carries the pending
// badge + running spinner (feature-spec.md:111).
// Eval — the workbench is described as "a tab inside Runs"
// (feature-spec.md:63), so it sits directly under Runs and its presets, and
// carries no tree in its route (eval cases are global, feature-spec.md:115).
// Casebooks sits next to Eval — a casebook's whole point is becoming
// an eval set or a replay suite. Inspector is ROLE-gated: it renders
// only when /me.roles includes `inspect` (openapi.yaml:308 "Requires the
// inspect role"), never on the auth mode — an off-mode backend simply answers
// /me with the dev user's roles (feature-spec.md:17 "default admin = all trees,
// all rights").
const NAV = [
  { to: "/chat", label: "Chat" },
  { to: "/runs", label: "Runs" },
  { to: "/eval", label: "Eval" },
  { to: "/casebooks", label: "Casebooks" },
  { to: "/inspector", label: "Inspector", role: "inspect" as const },
  { to: "/queue", label: "Queue" },
  { to: "/agents", label: "Agents" },
];

// Presets nest under Runs (feature-spec.md:4 "Menus: Chat, Runs
// (Tune / Evaluate presets), Settings"; :102-103). They are LINKS into the
// same Runs page, not routes of their own — the preset travels as router
// state, the same handoff mechanism as Test-in-Runs.
const PRESETS = [
  { preset: "tune", label: "Tune" },
  { preset: "evaluate", label: "Evaluate" },
] as const;

// Badge on the Queue entry: "Sidebar badge: pending count; subtle
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
  const { tree, me } = useApp();
  const navigate = useNavigate();

  // Session row: user name from /me; "Sign out" shows EXACTLY when a
  // login token exists for the active target (the no-branch rule from the
  // task: an off-mode backend issues no token on boot, so the dev user shows
  // without a sign-out — the token's presence is the signal, never the
  // auth mode). Sign out = best-effort POST /auth/logout (stateless JWTs:
  // the mock 204s; a failure is ignored), then drop the token and go to
  // /login (feature-spec.md:18 "Session shown ... with sign-out").
  const authToken = useAuthToken();
  const signOut = async () => {
    try {
      await api.logout();
    } catch {
      // best-effort — the token is discarded regardless
    }
    clearAuthToken();
    navigate("/login");
  };

  return (
    <>
      <AppShell.Section>
        <Stack gap={4}>
          {/* New chat button at top (feature-spec.md:5) — opens the empty
              chat page. */}
          <Button variant="default" size="xs" onClick={() => navigate("/chat")}>
            + New chat
          </Button>
          {NAV.filter((item) => !item.role || (me.roles?.includes(item.role) ?? false)).map((item) => (
            <Fragment key={item.to}>
              <NavLink
                component={RouterNavLink}
                to={item.to}
                label={item.label}
                rightSection={item.to === "/queue" ? <QueueIndicator /> : undefined}
              />
              {item.to === "/runs" &&
                PRESETS.map((p) => (
                  <NavLink
                    key={p.preset}
                    component={RouterNavLink}
                    to="/runs"
                    state={{ preset: p.preset }}
                    label={p.label}
                    pl={28}
                  />
                ))}
            </Fragment>
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
      {/* Settings pinned at the bottom, below the recent list
          (feature-spec.md:4 "Menus: Chat, Runs (Tune / Evaluate presets),
          Settings"). First section: Settings → Backend (sketch 09). */}
      <AppShell.Section>
        <Divider my="xs" />
        <NavLink component={RouterNavLink} to="/settings" label="Settings" />
        <Group justify="space-between" wrap="nowrap" px={8} py={4}>
          <Text size="xs" c="dimmed" truncate title={me.user.email ?? me.user.name}>
            {me.user.name}
          </Text>
          {authToken && (
            <Button variant="subtle" size="compact-xs" color="gray" onClick={signOut}>
              Sign out
            </Button>
          )}
        </Group>
      </AppShell.Section>
    </>
  );
}
