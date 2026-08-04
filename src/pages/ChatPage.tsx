import { useEffect, useState } from "react";
import { useParams } from "react-router";
import { Alert, Center, Group, Loader, Paper, Stack, Text, Title } from "@mantine/core";
import { api, ApiError } from "../api/client";
import type { Conversation } from "../api/types";
import { useApp } from "../AppContext";

// P1-T01 scope: read-only transcript from
// GET /agenttrees/{tree}/conversations/{conversationId} (openapi.yaml:387).
// Composer, SSE streaming, markdown and turn actions are P1-T02/T03/T04.
export function ChatPage() {
  const { conversationId } = useParams();
  const { tree } = useApp();
  const [conv, setConv] = useState<Conversation | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setConv(null);
    setError(null);
    if (!conversationId) return;
    let cancelled = false;
    api
      .conversation(tree, conversationId)
      .then((data) => {
        if (!cancelled) setConv(data);
      })
      .catch((e: ApiError) => {
        if (!cancelled) setError(e.message);
      });
    return () => {
      cancelled = true;
    };
  }, [tree, conversationId]);

  if (!conversationId) {
    return (
      <Center h="80vh">
        <Text c="dimmed">Select a conversation, or start a new chat (coming in P1-T02).</Text>
      </Center>
    );
  }
  if (error) {
    return <Alert color="red" title="Could not load conversation">{error}</Alert>;
  }
  if (!conv) {
    return (
      <Center h="80vh">
        <Loader />
      </Center>
    );
  }

  return (
    <Stack gap="sm" maw={760} mx="auto">
      <Title order={4}>{conv.title}</Title>
      {(conv.turns ?? []).map((turn) => (
        <Paper
          key={turn.id}
          p="sm"
          radius="md"
          withBorder={turn.role === "assistant"}
          bg={turn.role === "user" ? "blue.0" : undefined}
          ml={turn.role === "user" ? "20%" : 0}
          mr={turn.role === "assistant" ? "10%" : 0}
        >
          <Group justify="space-between" mb={4}>
            <Text size="xs" c="dimmed">
              {turn.author}
            </Text>
            <Text size="xs" c="dimmed">
              {new Date(turn.created_at).toLocaleString()}
            </Text>
          </Group>
          <Text size="sm" style={{ whiteSpace: "pre-wrap" }}>
            {turn.content}
          </Text>
        </Paper>
      ))}
    </Stack>
  );
}
