import { NavLink as RouterNavLink, useLocation, useNavigate } from "react-router";
import {
  ActionIcon,
  AppShell,
  Badge,
  Button,
  Divider,
  Group,
  Indicator,
  Loader,
  NavLink,
  Select,
  Stack,
  Text,
  Tooltip,
} from "@mantine/core";
import {
  IconHome,
  IconLayoutSidebarLeftCollapse,
  IconLayoutSidebarLeftExpand,
  IconListDetails,
  IconLogout,
  IconMessageCircle,
  IconPlus,
  IconRobot,
  IconSettings,
  IconTool,
  type Icon,
} from "@tabler/icons-react";
import { api } from "../api/client";
import { clearAuthToken, useAuthToken } from "../api/auth";
import { useApp } from "../AppContext";
import { useQueue } from "../QueueContext";
import { familyAnswer, isRouteHidden, isStudioHidden, landingRoute } from "../lib/families";
import { ConversationList } from "./ConversationList";

// Doors: Chat (talk to the agent), Studio (cases/sets/rubrics, the
// run/results flow, and — role-gated — the Inspector, as tabs on one page;
// formerly the separate Evaluate group + a standalone Inspector entry,
// merged 2026-08-10), Queue, Agents. Chat carries the recent list
// (feature-spec.md:5 "Expanded sidebar shows recent conversations under
// Chat"); Queue carries the pending badge + running spinner
// (feature-spec.md:107). Studio's own role gate for its Inspector tab lives
// in StudioPage.tsx, not here — there is nothing left at this level to gate.
interface NavLeaf {
  to: string;
  label: string;
  icon: Icon;
}
const NAV: NavLeaf[] = [
  { to: "/chat", label: "Chat", icon: IconMessageCircle },
  { to: "/studio", label: "Studio", icon: IconTool },
  { to: "/queue", label: "Queue", icon: IconListDetails },
  { to: "/agents", label: "Agents", icon: IconRobot },
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
        <Badge size="xs" variant="light" ff="monospace" data-testid="queue-badge">
          {pendingCount}
        </Badge>
      )}
    </Group>
  );
}

// A generated app answers `hide` for the families it does not want (agentic.
// config.ts families) — those doors are gone from here and their routes are
// gone from App.tsx. Studio merges two families into one route, so its
// show/hide call is isStudioHidden() (visible if EITHER survives), not the
// generic per-route check every other entry uses.
function visibleNav(): NavLeaf[] {
  return NAV.filter((entry) => (entry.to === "/studio" ? !isStudioHidden() : !isRouteHidden(entry.to)));
}

function isActivePath(pathname: string, to: string): boolean {
  return pathname === to || pathname.startsWith(`${to}/`);
}

// One rail icon: same target/role as its expanded NavLink, an
// ActionIcon-sized hit target, active state computed the same way
// react-router's own NavLink would (exact or nested-path match), tooltip
// carrying the label that disappeared with the sidebar's text column.
function RailLink({
  to,
  label,
  icon: IconCmp,
  indicator,
}: {
  to: string;
  label: string;
  icon: Icon;
  indicator?: { value?: number; processing?: boolean };
}) {
  const { pathname } = useLocation();
  const active = isActivePath(pathname, to);
  const button = (
    <ActionIcon
      component={RouterNavLink}
      to={to}
      variant={active ? "light" : "subtle"}
      color={active ? "blue" : "gray"}
      size="lg"
      aria-label={label}
    >
      <IconCmp size={20} stroke={1.5} />
    </ActionIcon>
  );
  return (
    <Tooltip label={label} position="right" openDelay={200} withArrow>
      {indicator ? (
        <Indicator
          label={indicator.value}
          disabled={!indicator.value && !indicator.processing}
          processing={indicator.processing}
          size={16}
          color="blue"
        >
          {button}
        </Indicator>
      ) : (
        button
      )}
    </Tooltip>
  );
}

export function Sidebar({
  collapsed = false,
  onToggleCollapsed,
}: {
  collapsed?: boolean;
  onToggleCollapsed?: () => void;
}) {
  const { tree, trees, setTree, me } = useApp();
  const navigate = useNavigate();
  const nav = visibleNav();
  // The recent list is conversation history; hiding that family hides the
  // list, and hiding chat hides the button that starts one.
  const showRecent = !isRouteHidden("/chat") && familyAnswer("conversations") !== "hide";
  const { pendingCount, running } = useQueue();

  // Switching trees invalidates every tree-scoped id already in the URL
  // (a conversation, an agent, a turn — all belong to the OLD tree), so a
  // switch always lands on the landing route rather than trying to carry the
  // current page across trees. No-op on the id already active (Select fires
  // onChange even for a no-op re-pick).
  const switchTree = (id: string | null) => {
    if (!id || id === tree) return;
    setTree(id);
    navigate(landingRoute());
  };

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
        <Stack gap={4} align={collapsed ? "center" : undefined}>
          <Group justify={collapsed ? "center" : "flex-end"} wrap="nowrap">
            {onToggleCollapsed && (
              <Tooltip label={collapsed ? "Expand sidebar" : "Collapse sidebar"} position="right">
                <ActionIcon
                  variant="subtle"
                  color="gray"
                  size="sm"
                  aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
                  onClick={onToggleCollapsed}
                >
                  {collapsed ? (
                    <IconLayoutSidebarLeftExpand size={16} stroke={1.5} />
                  ) : (
                    <IconLayoutSidebarLeftCollapse size={16} stroke={1.5} />
                  )}
                </ActionIcon>
              </Tooltip>
            )}
          </Group>
          {/* New chat button at top (feature-spec.md:5) — opens the empty
              chat page. */}
          {!isRouteHidden("/chat") &&
            (collapsed ? (
              <Tooltip label="New chat" position="right" withArrow>
                <ActionIcon
                  variant="default"
                  size="lg"
                  aria-label="New chat"
                  onClick={() => navigate("/chat")}
                >
                  <IconPlus size={18} stroke={1.5} />
                </ActionIcon>
              </Tooltip>
            ) : (
              <Button variant="light" size="xs" radius="sm" onClick={() => navigate("/chat")}>
                + New chat
              </Button>
            ))}
          {collapsed
            ? nav.map((entry) => (
                <RailLink
                  key={entry.to}
                  to={entry.to}
                  label={entry.label}
                  icon={entry.icon}
                  indicator={
                    entry.to === "/queue" ? { value: pendingCount, processing: running } : undefined
                  }
                />
              ))
            : nav.map((entry) => (
                <NavLink
                  key={entry.to}
                  component={RouterNavLink}
                  to={entry.to}
                  label={entry.label}
                  rightSection={entry.to === "/queue" ? <QueueIndicator /> : undefined}
                />
              ))}
        </Stack>
        {/* Tree switcher — same room constraint as Recent below, hidden on
            the rail. Nothing to switch BETWEEN with only one tree, so it
            stays out of the way for single-tree checkouts. Disabled trees
            (AgentTree.enabled — only an admin viewer ever sees one at all,
            openapi.yaml AgentTree.enabled) are listed but unselectable,
            "rendered greyed with a disabled badge" per that field's own
            description. */}
        {!collapsed && trees.length > 1 && (
          <>
            <Divider my="xs" />
            <Select
              size="xs"
              variant="filled"
              radius="sm"
              label="Tree"
              px={4}
              data={trees.map((t) => ({
                value: t.id,
                label: t.enabled ? t.name : `${t.name} (disabled)`,
                disabled: !t.enabled,
              }))}
              value={tree}
              onChange={switchTree}
              allowDeselect={false}
              comboboxProps={{ withinPortal: false }}
            />
          </>
        )}
        {/* The recent-conversations list needs room a rail doesn't have —
            hidden while collapsed rather than crammed in; expand to see it. */}
        {showRecent && !collapsed && (
          <>
            <Divider my="xs" />
            <Text size="xs" c="dimmed" fw={600} tt="uppercase" px={4}>
              {tree} · Recent
            </Text>
          </>
        )}
      </AppShell.Section>
      <AppShell.Section grow style={{ overflowY: "auto" }} mt={4}>
        {showRecent && !collapsed && <ConversationList tree={tree} />}
      </AppShell.Section>
      {/* Settings pinned at the bottom, below the recent list.
          First section: Settings → Backend (sketch 09). */}
      <AppShell.Section>
        <Divider my="xs" />
        {collapsed ? (
          <Stack gap={4} align="center">
            {/* Not a router route — an actual link back to the persona
                landing page (docs/index.html serves at the domain root;
                mock/root.py mounts this whole app at /cupel-demo alongside
                it), hence a plain <a href="/"> rather than RouterNavLink. */}
            <Tooltip label="Landing / FAQ" position="right" withArrow>
              <ActionIcon component="a" href="/" variant="subtle" color="gray" size="lg">
                <IconHome size={20} stroke={1.5} />
              </ActionIcon>
            </Tooltip>
            {!isRouteHidden("/settings") && (
              <RailLink to="/settings" label="Settings" icon={IconSettings} />
            )}
            {authToken && (
              <Tooltip label="Sign out" position="right" withArrow>
                <ActionIcon
                  variant="subtle"
                  color="gray"
                  size="lg"
                  aria-label="Sign out"
                  onClick={signOut}
                >
                  <IconLogout size={18} stroke={1.5} />
                </ActionIcon>
              </Tooltip>
            )}
          </Stack>
        ) : (
          <>
            <NavLink component="a" href="/" label="Landing / FAQ" />
            {!isRouteHidden("/settings") && (
              <NavLink component={RouterNavLink} to="/settings" label="Settings" />
            )}
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
          </>
        )}
      </AppShell.Section>
    </>
  );
}
