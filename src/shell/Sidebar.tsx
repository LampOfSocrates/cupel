import { NavLink as RouterNavLink, useNavigate } from "react-router";
import { AppShell, Badge, Button, Divider, Group, Loader, NavLink, Stack, Text } from "@mantine/core";
import { api } from "../api/client";
import { clearAuthToken, useAuthToken } from "../api/auth";
import { useApp } from "../AppContext";
import { useQueue } from "../QueueContext";
import { ConversationList } from "./ConversationList";

// Two doors: Chat (talk to the agent) and Evaluate (the studio loop).
// Evaluations and Eval are ONE workflow — what to test, the results, how to
// score — so they nest under a single Evaluate group instead of sitting as
// peers. Casebooks was a third entry until Casebook and EvalSet merged; the
// collections it listed are the Eval workbench's Sets tab now. The group
// starts open: it is the whole point of the second door, not a disclosure.
// Chat carries the recent list (feature-spec.md:5 "Expanded sidebar shows
// recent conversations under Chat"); Queue carries the pending badge + running
// spinner (feature-spec.md:107). Inspector is ROLE-gated: it renders only when
// /me.roles includes `inspect` (openapi.yaml:308 "Requires the inspect role"),
// never on the auth mode — an off-mode backend simply answers /me with the dev
// user's roles (feature-spec.md:17 "default admin = all trees, all rights").
interface NavLeaf {
  to: string;
  label: string;
  role?: "inspect";
}
interface NavGroup {
  label: string;
  children: NavLeaf[];
}
const NAV: (NavLeaf | NavGroup)[] = [
  { to: "/chat", label: "Chat" },
  {
    label: "Evaluate",
    children: [
      { to: "/evaluations", label: "Evaluations" },
      { to: "/eval", label: "Eval" },
    ],
  },
  { to: "/inspector", label: "Inspector", role: "inspect" },
  { to: "/queue", label: "Queue" },
  { to: "/agents", label: "Agents" },
];

// Badge on the Queue entry: "Sidebar badge: pending count; subtle
// spinner while anything is running" (feature-spec.md:107) — pending =
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
          {NAV.map((entry) =>
            "children" in entry ? (
              <NavLink
                key={entry.label}
                component="button"
                label={entry.label}
                defaultOpened
                childrenOffset={28}
              >
                {entry.children.map((child) => (
                  <NavLink
                    key={child.to}
                    component={RouterNavLink}
                    to={child.to}
                    label={child.label}
                  />
                ))}
              </NavLink>
            ) : !entry.role || (me.roles?.includes(entry.role) ?? false) ? (
              <NavLink
                key={entry.to}
                component={RouterNavLink}
                to={entry.to}
                label={entry.label}
                rightSection={entry.to === "/queue" ? <QueueIndicator /> : undefined}
              />
            ) : null,
          )}
        </Stack>
        <Divider my="xs" />
        <Text size="xs" c="dimmed" fw={600} tt="uppercase" px={4}>
          {tree} · Recent
        </Text>
      </AppShell.Section>
      <AppShell.Section grow style={{ overflowY: "auto" }} mt={4}>
        <ConversationList tree={tree} />
      </AppShell.Section>
      {/* Settings pinned at the bottom, below the recent list.
          First section: Settings → Backend (sketch 09). */}
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
