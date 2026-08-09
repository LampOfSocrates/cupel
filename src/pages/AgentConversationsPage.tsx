import { useNavigate, useParams } from "react-router";
import { Group, Loader, Stack, Text, Title, UnstyledButton } from "@mantine/core";
import { api } from "../api/client";
import { useAsync } from "../hooks/useAsync";
import { relativeTime } from "../lib/relativeTime";
import { useApp } from "../AppContext";

// Minimal target for the tree-view node ⋯ "view recent conversations for this
// agent" (feature-spec.md:26), backed by GET /conversations?agent_id=
// (openapi.yaml:365-371). Deliberately simple for Phase 1: a main-pane list of
// the agent's conversations, each opening in Chat — the sidebar itself gains
// no agent filter.
export function AgentConversationsPage() {
  const { agentId } = useParams();
  const { tree } = useApp();
  const navigate = useNavigate();
  const { data: items, error } = useAsync(
    () => api.conversations(tree, { agent_id: agentId }).then((page) => page.items),
    [tree, agentId],
  );

  return (
    <Stack gap="sm">
      <Title order={3}>Recent conversations — {agentId}</Title>
      {error && (
        <Text size="sm" c="red">
          {error.message}
        </Text>
      )}
      {!error && items === null && <Loader size="sm" />}
      {items?.length === 0 && (
        <Text size="sm" c="dimmed">
          No conversations for this agent yet.
        </Text>
      )}
      {items?.map((conv) => (
        <UnstyledButton
          key={conv.id}
          onClick={() => navigate(`/chat/${conv.id}`)}
          px={6}
          py={4}
          aria-label={`Open ${conv.title}`}
        >
          <Group justify="space-between" wrap="nowrap" gap={6}>
            <Text size="sm" truncate>
              {conv.title}
            </Text>
            <Text size="xs" c="dimmed" style={{ whiteSpace: "nowrap" }}>
              {relativeTime(conv.last_activity_at)}
            </Text>
          </Group>
        </UnstyledButton>
      ))}
    </Stack>
  );
}
