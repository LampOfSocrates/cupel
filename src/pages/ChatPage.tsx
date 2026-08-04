import { useEffect, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router";
import {
  ActionIcon,
  Alert,
  Button,
  Center,
  CopyButton,
  Group,
  Loader,
  Paper,
  Stack,
  Text,
  Textarea,
  Title,
} from "@mantine/core";
import { api, ApiError } from "../api/client";
import type { Judgment, Turn } from "../api/types";
import { useApp } from "../AppContext";
import { Markdown } from "../lib/markdown";

// P1-T02: live chat page.
// Contract (openapi.yaml:466-476): "stream=true → 200 text/event-stream with
// events: task (first event; carries the task_id used for stop = DELETE
// /tasks/{task_id}, plus conversation and turn ids) / token (one per streamed
// token/delta) / done (terminal ... status cancelled = stop-generation fired
// mid-stream and the turn carries the partial content generated so far, which
// IS persisted) / error".
// "Omitting conversation_id starts a new conversation" (openapi.yaml:488).
// UI spec (feature-spec.md:10-13): "Message list with streaming assistant
// responses (markdown + code blocks)" ... "Auto-scroll on stream;
// stop-generation button while streaming."

interface StreamState {
  draft: string;
  taskId: string | null; // null until the `task` event arrives
}

type Rating = "up" | "down";

// P1-T03: per-turn thumb state from judgment history. Judgments arrive
// "newest first" (openapi.yaml:994) and are append-only, so the current thumb
// is the FIRST type:human judgment per turn_id; "For type human, 1 = 👍 and
// 0 = 👎" (openapi.yaml:1905).
function deriveThumbs(judgments: Judgment[]): Record<string, Rating> {
  const thumbs: Record<string, Rating> = {};
  for (const j of judgments) {
    if (j.type !== "human" || !j.turn_id || j.turn_id in thumbs) continue;
    thumbs[j.turn_id] = j.score === 1 ? "up" : "down";
  }
  return thumbs;
}

export function ChatPage() {
  const { conversationId } = useParams();
  const { tree, refreshConversations } = useApp();
  const navigate = useNavigate();

  const [turns, setTurns] = useState<Turn[] | null>(conversationId ? null : []);
  const [title, setTitle] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [stream, setStream] = useState<StreamState | null>(null);
  const [sendError, setSendError] = useState<string | null>(null);
  const [input, setInput] = useState("");
  const [thumbs, setThumbs] = useState<Record<string, Rating>>({});

  // Conversation id whose turns the local state already holds — set when a
  // send attaches to it (via the SSE `task` event) or when a GET completes.
  // Lets the post-send navigate skip a refetch that would wipe the stream.
  const attachedConvRef = useRef<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  // Auto-scroll pinned to bottom unless the user scrolled up
  // (feature-spec.md:13 "Auto-scroll on stream").
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const pinnedRef = useRef(true);
  useEffect(() => {
    const el = scrollRef.current;
    if (el && pinnedRef.current) el.scrollTop = el.scrollHeight;
  }, [turns, stream?.draft]);

  // History via GET conversation on route entry (openapi.yaml:387); streaming
  // appends to it.
  useEffect(() => {
    setLoadError(null);
    // Our own send navigated here (task event attached first) — keep the
    // in-flight stream and local turns; no refetch.
    if (attachedConvRef.current === conversationId) return;
    // Switching to a different conversation (or a fresh new chat): a stream
    // still running belongs to the old transcript — abort it.
    abortRef.current?.abort();
    setStream(null);
    setSendError(null);
    if (!conversationId) {
      attachedConvRef.current = null;
      setTurns([]);
      setTitle(null);
      setThumbs({});
      return;
    }
    setTurns(null);
    setTitle(null);
    setThumbs({});
    let cancelled = false;
    api
      .conversation(tree, conversationId)
      .then((data) => {
        if (cancelled) return;
        attachedConvRef.current = conversationId;
        setTurns(data.turns ?? []);
        setTitle(data.title);
      })
      .catch((e: ApiError) => {
        if (!cancelled) setLoadError(e.message);
      });
    // Re-render 👍/👎 from judgment history — one call for the whole
    // transcript via the conversation_id filter (openapi.yaml:966-968,
    // :983-985). Non-critical: a failure leaves thumbs unset, transcript
    // still renders.
    api
      .judgments({ conversation_id: conversationId })
      .then((judgments) => {
        if (!cancelled) setThumbs(deriveThumbs(judgments));
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [tree, conversationId]);

  // Abort an in-flight stream when the page unmounts.
  useEffect(() => () => abortRef.current?.abort(), []);

  const streaming = stream !== null;

  const send = async () => {
    const text = input.trim();
    if (!text || streaming) return;
    setInput("");
    setSendError(null);
    const optimistic: Turn = {
      id: `local-${Date.now()}`,
      role: "user",
      author: "user",
      content: text,
      created_at: new Date().toISOString(),
      envelope: null,
    };
    setTurns((prev) => [...(prev ?? []), optimistic]);
    setStream({ draft: "", taskId: null });
    const abort = new AbortController();
    abortRef.current = abort;
    try {
      const result = await api.chat(
        tree,
        { message: text, conversation_id: conversationId, stream: true },
        { signal: abort.signal },
      );
      if (result.kind === "json") {
        // Backend degraded to a single JSON ChatResponse (loom-phases.md:43)
        attachedConvRef.current = result.response.conversation_id;
        setTurns((prev) => [...(prev ?? []), result.response.turn]);
        setStream(null);
        refreshConversations();
        if (conversationId !== result.response.conversation_id) {
          navigate(`/chat/${result.response.conversation_id}`);
        }
        return;
      }
      for await (const ev of result.events) {
        switch (ev.event) {
          case "task": {
            // First event: ids for stop + the (possibly new) conversation
            // (openapi.yaml:1447-1455).
            attachedConvRef.current = ev.data.conversation_id;
            setStream((s) => s && { ...s, taskId: ev.data.task_id });
            if (conversationId !== ev.data.conversation_id) {
              refreshConversations();
              navigate(`/chat/${ev.data.conversation_id}`);
            }
            break;
          }
          case "token":
            setStream((s) => s && { ...s, draft: s.draft + ev.data.delta });
            break;
          case "done":
            // completed AND cancelled both deliver the final Turn; on
            // cancelled it carries the persisted partial content
            // (openapi.yaml:1463-1473).
            setTurns((prev) => [...(prev ?? []), ev.data.turn]);
            setStream(null);
            refreshConversations();
            break;
          case "error":
            setSendError(ev.data.message);
            setStream(null);
            break;
        }
      }
    } catch (e) {
      if (!abort.signal.aborted) {
        setSendError(e instanceof Error ? e.message : String(e));
      }
      setStream(null);
    }
  };

  // Stop generation: DELETE /tasks/{task_id}; the stream then terminates with
  // done(status=cancelled) (openapi.yaml:835-839).
  const stop = () => {
    if (stream?.taskId) void api.cancelTask(stream.taskId);
  };

  // 👍/👎 → POST /feedback {message_id, rating} (openapi.yaml:1475-1480;
  // feature-spec.md:276). Optimistic; judgments are append-only (no un-vote
  // endpoint), so re-clicking the same thumb simply appends again.
  const rate = (turnId: string, rating: Rating) => {
    const previous = thumbs[turnId];
    setThumbs((m) => ({ ...m, [turnId]: rating }));
    api.postFeedback({ message_id: turnId, rating }).catch(() => {
      // Revert the optimistic thumb — the judgment was never appended.
      setThumbs((m) => {
        const next = { ...m };
        if (previous === undefined) delete next[turnId];
        else next[turnId] = previous;
        return next;
      });
    });
  };

  if (loadError) {
    return <Alert color="red" title="Could not load conversation">{loadError}</Alert>;
  }

  return (
    <Stack gap="sm" maw={760} mx="auto" h="calc(100vh - 2 * var(--mantine-spacing-md))">
      <Title order={4}>{title ?? (conversationId ? " " : "New chat")}</Title>
      <div
        ref={scrollRef}
        style={{ flex: 1, minHeight: 0, overflowY: "auto" }}
        onScroll={(e) => {
          const el = e.currentTarget;
          pinnedRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
        }}
      >
        {turns === null ? (
          <Center h="100%">
            <Loader />
          </Center>
        ) : (
          <Stack gap="sm" data-testid="transcript">
            {turns.length === 0 && !streaming && (
              <Text c="dimmed" ta="center" mt="xl">
                Send a message to start the conversation.
              </Text>
            )}
            {turns.map((turn) => (
              <TurnBubble
                key={turn.id}
                turn={turn}
                thumb={thumbs[turn.id]}
                onRate={(rating) => rate(turn.id, rating)}
              />
            ))}
            {stream && (
              <Paper p="sm" radius="md" withBorder mr="10%" data-testid="streaming-turn">
                {stream.draft === "" ? (
                  <Loader size="xs" type="dots" />
                ) : (
                  <Markdown content={stream.draft} />
                )}
              </Paper>
            )}
            {sendError && (
              <Alert color="red" title="Generation failed">
                {sendError}
              </Alert>
            )}
          </Stack>
        )}
      </div>
      {/* Minimal composer — polished version (attachments, uploads) is P1-T04.
          Enter = send, Shift+Enter = newline (feature-spec.md:12). */}
      <Group align="flex-end" gap="xs">
        <Textarea
          placeholder="Message…"
          value={input}
          onChange={(e) => setInput(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void send();
            }
          }}
          autosize
          minRows={1}
          maxRows={6}
          style={{ flex: 1 }}
        />
        {streaming ? (
          <ActionIcon
            size="lg"
            variant="filled"
            color="red"
            aria-label="Stop generation"
            onClick={stop}
            disabled={!stream?.taskId}
          >
            &#x25A0;
          </ActionIcon>
        ) : (
          <Button onClick={() => void send()} disabled={!input.trim()}>
            Send
          </Button>
        )}
      </Group>
    </Stack>
  );
}

function TurnBubble({
  turn,
  thumb,
  onRate,
}: {
  turn: Turn;
  thumb?: Rating;
  onRate: (rating: Rating) => void;
}) {
  return (
    <Paper
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
      {turn.role === "assistant" ? (
        <Markdown content={turn.content} />
      ) : (
        <Text size="sm" style={{ whiteSpace: "pre-wrap" }}>
          {turn.content}
        </Text>
      )}
      {/* Persistent action row, bottom-right per sketches/clean/01-chat.svg
          (👍👎⧉ — fork ⑂ is P1-T13, trace ⌁ is P1-T16; not built here).
          "Per assistant turn: 👍 / 👎 / copy buttons" (feature-spec.md:11). */}
      {turn.role === "assistant" && (
        <Group gap={2} justify="flex-end" mt={4}>
          <ActionIcon
            size="sm"
            variant={thumb === "up" ? "light" : "subtle"}
            color={thumb === "up" ? "blue" : "gray"}
            aria-label="Thumbs up"
            aria-pressed={thumb === "up"}
            onClick={() => onRate("up")}
          >
            &#x1F44D;
          </ActionIcon>
          <ActionIcon
            size="sm"
            variant={thumb === "down" ? "light" : "subtle"}
            color={thumb === "down" ? "blue" : "gray"}
            aria-label="Thumbs down"
            aria-pressed={thumb === "down"}
            onClick={() => onRate("down")}
          >
            &#x1F44E;
          </ActionIcon>
          {/* "copy copies raw markdown" (feature-spec.md:276) — Turn.content,
              not the rendered HTML. */}
          <CopyButton value={turn.content} timeout={1500}>
            {({ copied, copy }) => (
              <ActionIcon
                size="sm"
                variant="subtle"
                color={copied ? "teal" : "gray"}
                aria-label={copied ? "Copied" : "Copy message"}
                onClick={copy}
              >
                {copied ? "✓" : "⧉"}
              </ActionIcon>
            )}
          </CopyButton>
        </Group>
      )}
    </Paper>
  );
}
