import { memo, useCallback, useDeferredValue, useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router";
import {
  ActionIcon,
  Badge,
  Button,
  CopyButton,
  Group,
  Loader,
  Menu,
  Modal,
  Stack,
  Text,
  TextInput,
  UnstyledButton,
} from "@mantine/core";
import { useDebouncedValue } from "@mantine/hooks";
import { api } from "../api/client";
import type { Conversation } from "../api/types";
import { relativeTime } from "../lib/relativeTime";
import { conversationShareUrl } from "../lib/shareLink";
import { useApp } from "../AppContext";

// Sidebar recent list (feature-spec.md:5-6, sketch 07):
// "title + relative time, search, infinite scroll. Forked conversations nest
//  under their parent as a collapsed 'N forks' chip (expand to list; lineage
//  badge on each)" · "Conversation actions (long-press/⋯): rename, delete".
// Contract: GET /agenttrees/{tree}/conversations — roots only by default;
// ?forks_of= lists a conversation's forks (openapi.yaml:346-364).
//
// Not windowed: page_size maxes at 100 with a default of 20 (openapi.yaml:681-683)
// and growth is an explicit "Load more", so the mounted row count is user-bounded.
// Rows are also variable height (fork chip + expandable fork sublist) and the
// scroll container is the AppShell.Section that owns this list, not the list
// itself — a hand-rolled fixed-height window would be wrong on both counts.

interface Props {
  tree: string;
}

export function ConversationList({ tree }: Props) {
  const { conversationsVersion } = useApp();
  const navigate = useNavigate();
  const { conversationId } = useParams();
  const [search, setSearch] = useState("");
  // The input keeps the urgent value; everything downstream of it re-renders at
  // low priority so a keystroke is never blocked by the list.
  const deferredSearch = useDeferredValue(search);
  const [debouncedSearch] = useDebouncedValue(deferredSearch, 250);
  const [items, setItems] = useState<Conversation[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(false);
  const [forks, setForks] = useState<Record<string, Conversation[] | "loading">>({});
  const [renaming, setRenaming] = useState<Conversation | null>(null);

  const load = useCallback(
    async (pageNum: number, append: boolean) => {
      setLoading(true);
      try {
        const data = await api.conversations(tree, {
          search: debouncedSearch || undefined,
          page: pageNum,
        });
        setItems((prev) => (append ? [...prev, ...data.items] : data.items));
        setTotal(data.total);
        setPage(data.page);
      } finally {
        setLoading(false);
      }
    },
    [tree, debouncedSearch],
  );

  // conversationsVersion: chat sends bump it so new/updated conversations
  // appear without a manual reload.
  useEffect(() => {
    setForks({});
    void load(1, false);
  }, [load, conversationsVersion]);

  const toggleForks = async (conv: Conversation) => {
    if (forks[conv.id]) {
      setForks((prev) => {
        const next = { ...prev };
        delete next[conv.id];
        return next;
      });
      return;
    }
    setForks((prev) => ({ ...prev, [conv.id]: "loading" }));
    const data = await api.conversations(tree, { forks_of: conv.id });
    setForks((prev) => ({ ...prev, [conv.id]: data.items }));
  };

  // Stable identities so memo(ConversationRow) actually holds — an inline arrow
  // per row would invalidate every row on every parent render.
  const openConversation = useCallback(
    (conv: Conversation) => navigate(`/chat/${conv.id}`),
    [navigate],
  );

  const startRename = useCallback((conv: Conversation) => setRenaming(conv), []);

  const remove = useCallback(
    async (conv: Conversation) => {
      await api.deleteConversation(tree, conv.id);
      setItems((prev) => prev.filter((c) => c.id !== conv.id));
      setTotal((t) => t - 1);
    },
    [tree],
  );

  const requestDelete = useCallback((conv: Conversation) => void remove(conv), [remove]);

  const rename = async (conv: Conversation, title: string) => {
    const updated = await api.renameConversation(tree, conv.id, title);
    setItems((prev) => prev.map((c) => (c.id === conv.id ? { ...c, title: updated.title } : c)));
    setRenaming(null);
  };

  return (
    <Stack gap={2}>
      <TextInput
        size="xs"
        placeholder="Search"
        value={search}
        onChange={(e) => setSearch(e.currentTarget.value)}
        mb={4}
      />
      {items.map((conv) => (
        <div key={conv.id}>
          <ConversationRow
            conv={conv}
            activeId={conversationId}
            onOpen={openConversation}
            onRename={startRename}
            onDelete={requestDelete}
          />
          {conv.fork_count > 0 && (
            <Button
              variant="subtle"
              color="gray"
              size="compact-xs"
              ml="md"
              // Addressable per conversation: the label ("⑂ 2 forks") repeats
              // across rows, so e2e needs the id to target one.
              data-testid={`forks-${conv.id}`}
              onClick={() => void toggleForks(conv)}
            >
              &#x2442; {conv.fork_count} forks {forks[conv.id] ? "▴" : "▸"}
            </Button>
          )}
          {forks[conv.id] === "loading" && <Loader size="xs" ml="lg" />}
          {Array.isArray(forks[conv.id]) && (
            <Stack gap={0} ml="lg">
              {(forks[conv.id] as Conversation[]).map((fork) => (
                <ForkRow key={fork.id} fork={fork} />
              ))}
            </Stack>
          )}
        </div>
      ))}
      {loading && <Loader size="xs" mx="auto" my={4} />}
      {!loading && items.length === 0 && (
        <Text size="xs" c="dimmed" ta="center" my="sm">
          {debouncedSearch ? "No matches" : "No conversations yet"}
        </Text>
      )}
      {!loading && items.length < total && (
        <Button variant="subtle" size="compact-xs" onClick={() => void load(page + 1, true)}>
          Load more
        </Button>
      )}
      <Modal opened={renaming !== null} onClose={() => setRenaming(null)} title="Rename conversation">
        {renaming && (
          <RenameForm
            initial={renaming.title}
            onSubmit={(title) => void rename(renaming, title)}
          />
        )}
      </Modal>
    </Stack>
  );
}

// Hook-free on purpose: useParams/useNavigate both subscribe to the router's
// location, which would re-render every row on any navigation even when the row
// itself is unchanged. The active id arrives as a prop instead.
const ConversationRow = memo(function ConversationRow({
  conv,
  activeId,
  onOpen,
  onRename,
  onDelete,
}: {
  conv: Conversation;
  activeId: string | undefined;
  onOpen: (conv: Conversation) => void;
  onRename: (conv: Conversation) => void;
  onDelete: (conv: Conversation) => void;
}) {
  const active = activeId === conv.id;

  return (
    <Group gap={4} wrap="nowrap">
      <UnstyledButton
        onClick={() => onOpen(conv)}
        px={6}
        py={4}
        style={{
          flex: 1,
          minWidth: 0,
          borderRadius: 6,
          background: active ? "var(--mantine-color-blue-0)" : undefined,
        }}
      >
        <Group justify="space-between" wrap="nowrap" gap={4}>
          <Text size="xs" truncate fw={active ? 600 : 400}>
            {conv.title}
          </Text>
          <Text size="xs" c="dimmed" style={{ whiteSpace: "nowrap" }}>
            {relativeTime(conv.last_activity_at)}
          </Text>
        </Group>
      </UnstyledButton>
      <Menu position="bottom-end" withinPortal>
        <Menu.Target>
          <ActionIcon variant="subtle" color="gray" size="sm" aria-label={`Actions for ${conv.title}`}>
            &#x22EF;
          </ActionIcon>
        </Menu.Target>
        <Menu.Dropdown>
          <Menu.Item onClick={() => onRename(conv)}>Rename</Menu.Item>
          {/* "Copy link" joins rename/delete in the ⋯ menu
              (feature-spec.md:5-6). Same CopyButton affordance as the turn
              action row, so the confirmation reads identically; the menu is
              held open (closeMenuOnClick=false) precisely so that
              confirmation is visible. */}
          <CopyButton value={conversationShareUrl(conv.id)} timeout={1500}>
            {({ copied, copy }) => (
              <Menu.Item closeMenuOnClick={false} onClick={copy}>
                {copied ? "Link copied" : "Copy link"}
              </Menu.Item>
            )}
          </CopyButton>
          <Menu.Item color="red" onClick={() => onDelete(conv)}>
            Delete
          </Menu.Item>
        </Menu.Dropdown>
      </Menu>
    </Group>
  );
});

// Fork row with ↳ lineage badge (feature-spec.md:5 "lineage badge on each";
// sketch 07 "↳ prod · v15").
function ForkRow({ fork }: { fork: Conversation }) {
  const navigate = useNavigate();
  const endpoint = fork.lineage?.endpoint_id;
  const version = fork.lineage?.config?.instruction_version;

  return (
    <UnstyledButton onClick={() => navigate(`/chat/${fork.id}`)} px={6} py={2}>
      <Group gap={6} wrap="nowrap">
        <Text size="xs" c="dimmed" style={{ whiteSpace: "nowrap" }}>
          &#x21B3;
        </Text>
        <Text size="xs" truncate style={{ flex: 1 }}>
          {fork.title}
        </Text>
        {(endpoint || version != null) && (
          <Badge size="xs" variant="light" color="gray">
            {[endpoint, version != null ? `v${version}` : null].filter(Boolean).join(" · ")}
          </Badge>
        )}
      </Group>
    </UnstyledButton>
  );
}

function RenameForm({
  initial,
  onSubmit,
}: {
  initial: string;
  onSubmit: (title: string) => void;
}) {
  const [title, setTitle] = useState(initial);
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (title.trim()) onSubmit(title.trim());
      }}
    >
      <Stack gap="sm">
        <TextInput
          value={title}
          onChange={(e) => setTitle(e.currentTarget.value)}
          label="Title"
          data-autofocus
        />
        <Button type="submit" size="xs">
          Save
        </Button>
      </Stack>
    </form>
  );
}
