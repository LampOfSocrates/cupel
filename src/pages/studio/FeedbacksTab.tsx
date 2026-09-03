import { useEffect, useState } from "react";
import { Anchor, Badge, Box, Button, Group, Loader, Stack, Text } from "@mantine/core";
import { Link } from "react-router";
import { api } from "../../api/client";
import type { Judgment, JudgmentPage } from "../../api/types";
import { useApp } from "../../AppContext";
import { useAsync } from "../../hooks/useAsync";
import { relativeTime } from "../../lib/relativeTime";
import { useStudio } from "./StudioContext";

// Studio ▸ Feedbacks — the triage queue.
//
// "a user thumbs-down a turn in Chat → adds a note → the note lands in Studio ▸
// Feedbacks with the turn and agent tree attached" (the handoff's core loop).
// This is the landing side of that.
//
// It is ONE request: GET /eval/judgments?scorer_kind=human&tree=… . Both
// filters arrived in contract v0.7.0 for exactly this screen — thumbs and the
// LLM judge share one append-only store, and a judgment records its subject
// rather than its tree, so without them "the feedback on this tree" was not a
// question the store could be asked. The turn's own text is NOT fetched: a
// listing that costs one request per row is how a queue becomes unusable at
// the size a queue matters, and the note plus the link is enough to triage.
//
// WHAT THE CONTRACT CANNOT YET SAY: who left the feedback. Judgment.scorer for
// a human is {kind: human} with ref/version/model all null (openapi.yaml
// Scorer), so there is no rater identity to render. The handoff asks for it;
// it needs a contract change, and inventing "Someone" here would be worse than
// leaving the column out.

const PAGE_SIZE = 50;

function Sentiment({ score }: { score: number }) {
  const down = score === 0;
  return (
    <Badge
      size="xs"
      radius="lg"
      variant="light"
      color={down ? "danger" : "accent"}
      style={{ flexShrink: 0 }}
    >
      {down ? "👎 down" : "👍 up"}
    </Badge>
  );
}

function FeedbackRow({ judgment }: { judgment: Judgment }) {
  const { conversation_id: conversationId, subject } = judgment;
  return (
    <Box
      px={16}
      py={8}
      style={{ borderBottom: "1px solid var(--mantine-color-gray-2)", minWidth: 0 }}
    >
      <Group gap={8} wrap="nowrap" align="flex-start">
        <Sentiment score={judgment.score} />
        <Box style={{ flex: 1, minWidth: 0 }}>
          {/* The note is the row. A bare thumb has none, and says so rather
              than rendering an empty line that reads like a loading state. */}
          {judgment.reasoning ? (
            <Text fz="sm">{judgment.reasoning}</Text>
          ) : (
            <Text fz="sm" c="gray.5" fs="italic">
              No note — just the thumb.
            </Text>
          )}
          <Group gap={8} mt={2} wrap="nowrap">
            <Text ff="monospace" fz="xs" c="gray.5">
              {subject.id}
            </Text>
            <Text fz="xs" c="gray.6">
              {relativeTime(judgment.created_at)}
            </Text>
            {conversationId ? (
              // The jump the handoff asks for. Possible at all only because
              // Judgment carries conversation_id as of v0.7.0 — every route to
              // a turn is addressed by conversation, so before that a note
              // named a turn it could not take you to.
              <Anchor
                component={Link}
                to={`/chat/${conversationId}?turn=${subject.id}`}
                fz="xs"
              >
                Jump to conversation
              </Anchor>
            ) : (
              <Text fz="xs" c="gray.5">
                No conversation attached
              </Text>
            )}
          </Group>
        </Box>
      </Group>
    </Box>
  );
}

export function FeedbacksTab() {
  const { tree } = useApp();
  const { setError } = useStudio();
  // The first page, keyed on the tree — switching trees refetches rather than
  // carrying another tree's feedback across. useAsync owns the loading/error
  // contract every read in this app uses.
  const first = useAsync<JudgmentPage>(
    () => api.judgments({ scorer_kind: "human", tree, page: 1, page_size: PAGE_SIZE }),
    [tree],
  );
  // Pages 2..n, appended. Held apart from `first` so a tree switch drops them
  // automatically with the query they belonged to.
  const [more, setMore] = useState<{ tree: string; items: Judgment[]; page: number }>({
    tree,
    items: [],
    page: 1,
  });
  const [loadingMore, setLoadingMore] = useState(false);

  // The tab renders inside the frame that owns the error alert, so a failed
  // read is reported there rather than inline — one place errors surface.
  useEffect(() => {
    if (first.error) setError(first.error);
  }, [first.error, setError]);

  const extra = more.tree === tree ? more.items : [];
  const items = first.data ? [...first.data.items, ...extra] : null;
  const total = first.data?.total ?? 0;

  const loadMore = async () => {
    setLoadingMore(true);
    try {
      const next = (more.tree === tree ? more.page : 1) + 1;
      const res = await api.judgments({
        scorer_kind: "human",
        tree,
        page: next,
        page_size: PAGE_SIZE,
      });
      setMore((prev) => ({
        tree,
        items: prev.tree === tree ? [...prev.items, ...res.items] : res.items,
        page: next,
      }));
    } catch (e: unknown) {
      setError(e);
    } finally {
      setLoadingMore(false);
    }
  };

  if (items == null) {
    return (
      <Group gap="xs" p="md">
        <Loader size={12} />
        <Text fz="sm" c="gray.6">
          Loading feedback…
        </Text>
      </Group>
    );
  }

  if (items.length === 0) {
    // "Empty states: written as real sentences that explain what to do."
    return (
      <Text fz="sm" c="gray.6" p="md">
        No feedback on this tree yet. Thumb a reply up or down in Chat — add a note saying what
        the agent should have done instead — and it lands here.
      </Text>
    );
  }

  return (
    <Stack gap={0}>
      <Group
        px={16}
        py={6}
        justify="space-between"
        bg="gray.2"
        style={{ borderBottom: "1px solid var(--mantine-color-gray-4)" }}
      >
        <Text fz="xs" fw={600} c="gray.6" style={{ letterSpacing: "0.05em" }}>
          FEEDBACK
        </Text>
        <Text fz="xs" c="gray.6">
          {/* Both numbers, never just the loaded ones: `total` is matches
              across all pages, so a truncated view says it is truncated. */}
          {items.length === total ? `${total}` : `${items.length} of ${total}`}
        </Text>
      </Group>

      {items.map((judgment) => (
        <FeedbackRow key={judgment.id} judgment={judgment} />
      ))}

      {items.length < total && (
        <Group p="sm">
          <Button size="xs" variant="default" loading={loadingMore} onClick={() => void loadMore()}>
            Load more
          </Button>
        </Group>
      )}
    </Stack>
  );
}
