import { useNavigate, useParams } from "react-router";
import {
  Alert,
  Anchor,
  Badge,
  Group,
  Loader,
  Paper,
  SimpleGrid,
  Stack,
  Text,
  Title,
} from "@mantine/core";
import { api, ApiError } from "../api/client";
import type { Endpoint } from "../api/types";
import { useAsync } from "../hooks/useAsync";
import { useApp } from "../AppContext";
import { Markdown } from "../lib/markdown";

// Sibling fork comparison, the chat-side entry into the fork pivot.
// Spec (feature-spec.md:73): "Forked conversations appear in GET
// /conversations (filterable: forks_of={id}), and the comparison grid can
// pivot to compare forks of the same turn across endpoints (column per
// endpoint)."
//
// Design choice: when the pivot is reached from a
// RUN (ForkModal "View run"), RunDetailPage renders the server-pivoted
// grid. From a FORK's lineage banner no run id is discoverable — GET
// /agenttrees/{tree}/runs takes no turn filter (openapi.yaml:654-669) — but
// the SIBLINGS are: GET /conversations?forks_of={parent} (openapi.yaml:335)
// filtered client-side by lineage.fork_turn_id. So this route reconstructs
// the same one-turn-per-endpoint comparison from conversations alone:
// ComparisonView-like cards (annotated sketch 04 layout — "Baseline
// (original)" card + one card per endpoint, each with "Open in Chat ↗"),
// NOT a synthetic Run object (statuses/task ids would have to be invented).
// Column labels resolve endpoint ids → names via GET /endpoints, matching the
// re-fire run's server-built column labels (mock/main.py:634-635). A fork's
// result is its last turn when that turn is an assistant one (the regenerated
// turn is appended after the copied history, mock/main.py:664-673 +
// engine.py:354-363); otherwise the fork is still generating.

export function ForkComparePage() {
  const { tree } = useApp();
  const { parentId = "", turnId = "" } = useParams();
  const navigate = useNavigate();

  // Parent tombstone (openapi.yaml:438-443): a 404 renders "parent deleted"
  // while the sibling cards still load — lineage survives deletion.
  const { data: parent, error: parentError } = useAsync(
    () =>
      api.conversation(tree, parentId).catch((e: unknown) => {
        if (e instanceof ApiError && e.status === 404) return "deleted" as const;
        throw e;
      }),
    [tree, parentId],
  );
  const { data: siblings, error: siblingsError } = useAsync(
    () =>
      api
        .conversations(tree, { forks_of: parentId })
        .then((page) => page.items.filter((c) => c.lineage?.fork_turn_id === turnId)),
    [tree, parentId, turnId],
  );
  // Label columns with endpoint NAMES like the re-fire run grid does;
  // non-critical — ids render verbatim if this fails.
  const { data: endpoints } = useAsync(
    () => api.endpoints(tree).catch(() => [] as Endpoint[]),
    [tree],
  );

  const error = parentError ?? siblingsError;
  if (error) {
    return (
      <Alert color="red" title="Error" m="md" maw={640}>
        {error.message}
      </Alert>
    );
  }
  if (siblings == null) {
    return <Loader size="sm" mx="auto" my="xl" display="block" />;
  }

  const endpointName = (id: string | null | undefined) =>
    id ? (endpoints?.find((e) => e.id === id)?.name ?? id) : "unknown endpoint";
  const originalTurn =
    parent !== "deleted" && parent != null
      ? (parent.turns ?? []).find((t) => t.id === turnId)
      : undefined;

  return (
    <Stack gap="sm" p="md">
      <Group gap="xs" wrap="nowrap">
        <Badge size="sm" variant="light" color="grape">
          ⑂ forks
        </Badge>
        <Title order={4} style={{ minWidth: 0 }}>
          <Text span inherit truncate>
            Forks of{" "}
            {parent === "deleted" || parent == null ? parentId : parent.title} @ {turnId}
          </Text>
        </Title>
        {parent === "deleted" ? (
          <Text size="xs" c="dimmed" fs="italic">
            parent deleted
          </Text>
        ) : (
          <Anchor size="xs" onClick={() => navigate(`/chat/${parentId}`)}>
            Open parent
          </Anchor>
        )}
      </Group>
      {siblings.length === 0 && (
        <Text size="sm" c="dimmed">
          No forks of this turn.
        </Text>
      )}
      <SimpleGrid cols={{ base: 1, sm: 2, lg: 3 }} data-testid="sibling-grid">
        {/* Baseline card = the ORIGINAL turn on the parent (annotated sketch
            04 "Baseline (original)"). */}
        <Paper p="sm" radius="md" withBorder data-testid="sibling-baseline">
          <Group gap={6} mb={4} wrap="nowrap">
            <Text size="xs" fw={600}>
              baseline
            </Text>
            <Badge size="xs" variant="light" color="gray">
              original
            </Badge>
          </Group>
          {originalTurn ? (
            <Markdown content={originalTurn.content} />
          ) : (
            <Text size="xs" c="dimmed" fs="italic">
              original turn unavailable
            </Text>
          )}
          {parent !== "deleted" && (
            <Group justify="flex-end" mt={4}>
              <Anchor size="xs" onClick={() => navigate(`/chat/${parentId}`)}>
                Open in Chat ↗
              </Anchor>
            </Group>
          )}
        </Paper>
        {siblings.map((fork) => {
          const last = fork.turns?.at(-1);
          const result = last?.role === "assistant" ? last : undefined;
          return (
            <Paper p="sm" radius="md" withBorder key={fork.id} data-testid={`sibling-${fork.id}`}>
              <Group gap={6} mb={4} wrap="nowrap">
                <Text size="xs" fw={600}>
                  {endpointName(fork.lineage?.endpoint_id)}
                </Text>
                {fork.lineage?.config?.instruction_version != null && (
                  <Badge size="xs" variant="light" color="gray">
                    v{fork.lineage.config.instruction_version}
                  </Badge>
                )}
              </Group>
              {result ? (
                <Markdown content={result.content} />
              ) : (
                <Group gap={6} wrap="nowrap">
                  <Loader size="xs" />
                  <Text size="xs" c="dimmed">
                    generating…
                  </Text>
                </Group>
              )}
              <Group justify="flex-end" mt={4}>
                <Anchor size="xs" onClick={() => navigate(`/chat/${fork.id}`)}>
                  Open in Chat ↗
                </Anchor>
              </Group>
            </Paper>
          );
        })}
      </SimpleGrid>
    </Stack>
  );
}
