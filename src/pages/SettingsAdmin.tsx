import { useEffect, useState } from "react";
import {
  Alert,
  Badge,
  Button,
  Checkbox,
  Group,
  Loader,
  Paper,
  Stack,
  Switch,
  Table,
  Text,
  TextInput,
} from "@mantine/core";
import { api } from "../api/client";
import type { AdminUser, AgentTree, TreePermission } from "../api/types";
import { useApp } from "../AppContext";
import { product } from "../lib/product";

// The two admin Settings sections (unsketched; derived from the
// existing SettingsPage visual language per cupel-phases.md:95 — Paper blocks,
// dense xs controls):
// - Members (feature-spec.md:19): "user list, per-tree permission matrix
//   (view/tune/evaluate checkboxes)". Data = GET /admin/users + one
//   GET /admin/users/{id}/permissions per user (AdminUser carries roles only,
//   openapi.yaml:3019); a checkbox toggle PUTs the FULL matrix (PUT is "Full
//   replacement", openapi.yaml:246) optimistically and reverts on error.
//   Changes take effect on the target user's next request (openapi.yaml:
//   246-250) — no live push, nothing to refresh here. "invite by email"
//   (feature-spec.md:19) is the PUT /admin/users half: an unseen email
//   upserts an invited user (openapi.yaml:195-200) who appears in the list
//   with an empty matrix, ready to be granted trees.
// - Agent trees (feature-spec.md:20): "list all trees with an enable/disable
//   toggle per tree (PATCH /admin/agenttrees/{id} {enabled})". Disabling asks
//   for confirmation (new work blocked, history kept read-only) and disabled
//   rows carry a "disabled" badge (admins see them, openapi.yaml:443-446).
//
// Visibility is ROLE-driven, never mode-driven: SettingsPage renders these
// only when /me.roles includes admin (openapi.yaml:2008-2009 "admin gates the
// Settings → Members / Agent trees UI") — an off-mode backend simply answers
// /me with the dev user's roles, so no component branches on the auth mode.

const PERMISSIONS: TreePermission[] = ["view", "tune", "evaluate"];

export function MembersSection() {
  const { trees } = useApp();
  const [users, setUsers] = useState<AdminUser[] | null>(null);
  const [matrices, setMatrices] = useState<Record<string, Record<string, TreePermission[]>>>({});
  const [error, setError] = useState<string | null>(null);
  const [invite, setInvite] = useState("");
  const [inviting, setInviting] = useState(false);

  useEffect(() => {
    let cancelled = false;
    api
      .adminUsers()
      .then(async (list) => {
        const perms = await Promise.all(list.map((u) => api.userPermissions(u.id)));
        if (cancelled) return;
        setUsers(list);
        setMatrices(Object.fromEntries(perms.map((p) => [p.user_id, p.permissions])));
      })
      .catch((e: Error) => {
        if (!cancelled) setError(e.message);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const toggle = (userId: string, treeId: string, perm: TreePermission) => {
    const previous = matrices[userId] ?? {};
    const current = previous[treeId] ?? [];
    const next = {
      ...previous,
      [treeId]: current.includes(perm)
        ? current.filter((p) => p !== perm)
        : // Keep the contract enum's order so round-trips compare stably.
          PERMISSIONS.filter((p) => p === perm || current.includes(p)),
    };
    setMatrices((m) => ({ ...m, [userId]: next })); // optimistic
    api.putUserPermissions(userId, next).catch((e: Error) => {
      setMatrices((m) => ({ ...m, [userId]: previous })); // revert
      setError(e.message);
    });
  };

  // "invite by email" (feature-spec.md:19) — one upsert; the response IS the
  // stored row (openapi.yaml:210-217), so the list takes it verbatim rather
  // than refetching. An existing email upserts to the same row, so the list
  // replaces in place instead of duplicating.
  const sendInvite = () => {
    const email = invite.trim();
    if (!email || inviting) return;
    setInviting(true);
    api
      .putAdminUsers([{ email }])
      .then((upserted) => {
        setInvite("");
        setUsers((prev) => {
          const list = [...(prev ?? [])];
          for (const u of upserted) {
            const at = list.findIndex((existing) => existing.id === u.id);
            if (at >= 0) list[at] = u;
            else list.push(u);
          }
          return list;
        });
        setMatrices((m) => {
          const next = { ...m };
          for (const u of upserted) next[u.id] ??= {};
          return next;
        });
      })
      .catch((e: Error) => setError(e.message))
      .finally(() => setInviting(false));
  };

  return (
    <Paper withBorder p="md" radius="md">
      <Stack gap="sm">
        <Text fw={600}>Members</Text>
        {error && (
          <Alert color="red" withCloseButton onClose={() => setError(null)}>
            {error}
          </Alert>
        )}
        {users === null ? (
          !error && <Loader size="xs" aria-label="Loading members" />
        ) : (
          <Table.ScrollContainer minWidth={420}>
            <Table verticalSpacing={4} horizontalSpacing="sm" fz="xs">
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>User</Table.Th>
                  {trees.map((t) => (
                    <Table.Th key={t.id}>{t.name}</Table.Th>
                  ))}
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {users.map((u) => (
                  <Table.Tr key={u.id}>
                    <Table.Td>
                      <Group gap={6} wrap="nowrap">
                        <Text size="xs">{u.email}</Text>
                        {u.roles.map((role) => (
                          <Badge key={role} size="xs" variant="light">
                            {role}
                          </Badge>
                        ))}
                        {u.invited && (
                          <Badge size="xs" variant="outline" color="gray">
                            invited
                          </Badge>
                        )}
                      </Group>
                    </Table.Td>
                    {trees.map((t) => (
                      <Table.Td key={t.id}>
                        <Group gap={8} wrap="nowrap">
                          {PERMISSIONS.map((perm) => (
                            <Checkbox
                              key={perm}
                              size="xs"
                              label={perm}
                              aria-label={`${u.email} ${t.id} ${perm}`}
                              checked={(matrices[u.id]?.[t.id] ?? []).includes(perm)}
                              onChange={() => toggle(u.id, t.id, perm)}
                            />
                          ))}
                        </Group>
                      </Table.Td>
                    ))}
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </Table>
          </Table.ScrollContainer>
        )}
        <Group gap="xs" wrap="nowrap" maw={420}>
          <TextInput
            size="xs"
            flex={1}
            aria-label="Invite email"
            placeholder="teammate@example.com"
            value={invite}
            onChange={(e) => setInvite(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") sendInvite();
            }}
          />
          <Button size="compact-xs" variant="default" onClick={sendInvite} loading={inviting}>
            Invite
          </Button>
        </Group>
      </Stack>
    </Paper>
  );
}

export function AgentTreesSection() {
  const { trees } = useApp();
  // Local copy: AppContext trees are the boot snapshot; toggles update here
  // (the app-wide view refreshes on the next boot fetch — same next-request
  // semantics the permission matrix documents).
  const [rows, setRows] = useState<AgentTree[]>(trees);
  const [error, setError] = useState<string | null>(null);

  const toggle = (tree: AgentTree, enabled: boolean) => {
    if (
      !enabled &&
      !window.confirm(
        `Disable "${tree.name}"? New chats and evaluations are blocked; history stays readable.`,
      )
    ) {
      return;
    }
    setRows((prev) => prev.map((t) => (t.id === tree.id ? { ...t, enabled } : t))); // optimistic
    api
      .toggleTree(tree.id, enabled)
      .then((updated) => {
        setRows((prev) => prev.map((t) => (t.id === updated.id ? updated : t)));
      })
      .catch((e: Error) => {
        setRows((prev) => prev.map((t) => (t.id === tree.id ? tree : t))); // revert
        setError(e.message);
      });
  };

  return (
    <Paper withBorder p="md" radius="md">
      <Stack gap="sm">
        <Text fw={600}>{product.tree.Many}</Text>
        {error && (
          <Alert color="red" withCloseButton onClose={() => setError(null)}>
            {error}
          </Alert>
        )}
        {rows.map((tree) => (
          <Group key={tree.id} gap="sm" wrap="nowrap">
            <Switch
              size="xs"
              checked={tree.enabled}
              aria-label={`${tree.id} enabled`}
              onChange={(e) => toggle(tree, e.currentTarget.checked)}
            />
            <Text size="xs" style={{ opacity: tree.enabled ? 1 : 0.6 }}>
              {tree.name}
            </Text>
            <Text size="xs" c="dimmed">
              {tree.id}
            </Text>
            {!tree.enabled && (
              <Badge size="xs" color="gray" variant="light">
                disabled
              </Badge>
            )}
          </Group>
        ))}
      </Stack>
    </Paper>
  );
}
