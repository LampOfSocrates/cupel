import { useEffect, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router";
import {
  ActionIcon,
  Alert,
  Anchor,
  Badge,
  Button,
  Center,
  CloseButton,
  CopyButton,
  Divider,
  FileButton,
  Group,
  Indicator,
  Loader,
  NumberInput,
  Paper,
  PasswordInput,
  Popover,
  Select,
  Stack,
  Text,
  Textarea,
  Title,
  Tooltip,
} from "@mantine/core";
import { api, ApiError } from "../api/client";
import { getLlmKey, getLlmModel, setLlmKey, setLlmModel } from "../api/llmKey";
import type { Attachment, Judgment, Lineage, Model, Turn } from "../api/types";
import { EnvelopeChip, ForkModal } from "../components";
import { useApp, type ChatSettings } from "../AppContext";
import { formatBytes } from "../lib/formatBytes";
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

// P1-T04: one composer chip per picked file. Files upload immediately on pick
// ("multipart upload to /upload before send", feature-spec.md:277); a 413/415
// leaves the chip in state "error" with the server's message and its file is
// never referenced in ChatRequest.attachments ("the UI surfaces the message",
// openapi.yaml:535-536).
interface PendingUpload {
  key: number;
  filename: string;
  size: number;
  status: "uploading" | "done" | "error";
  attachment?: Attachment; // set when status === "done"
  error?: string; // server message when status === "error"
  previewUrl?: string; // object URL for image/* (client-side only — url is null in Phase 1, openapi.yaml:1284)
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
  const { tree, refreshConversations, chatSettings } = useApp();
  const navigate = useNavigate();

  const [turns, setTurns] = useState<Turn[] | null>(conversationId ? null : []);
  const [title, setTitle] = useState<string | null>(null);
  // P1-T13: lineage + agent off the loaded Conversation. Lineage is "Present
  // iff this conversation is a fork" (openapi.yaml:1369) and drives the header
  // banner; agent_id seeds the fork modal's optional version select.
  const [lineage, setLineage] = useState<Lineage | null>(null);
  const [agentId, setAgentId] = useState<string | null>(null);
  // Parent link state: title when it loads, "deleted" on 404 — "forks keep
  // their lineage (the parent link renders as deleted)" (openapi.yaml:441-443).
  const [parent, setParent] = useState<{ title: string } | "deleted" | null>(null);
  // ⑂ target — assistant turn id the fork modal is open for (null = closed).
  const [forkTurnId, setForkTurnId] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [stream, setStream] = useState<StreamState | null>(null);
  const [sendError, setSendError] = useState<string | null>(null);
  const [input, setInput] = useState("");
  const [thumbs, setThumbs] = useState<Record<string, Rating>>({});
  const [pending, setPending] = useState<PendingUpload[]>([]);
  const pendingKeyRef = useRef(0);

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
    // Pending composer chips belong to the conversation being left.
    setPending((prev) => {
      for (const p of prev) if (p.previewUrl) URL.revokeObjectURL(p.previewUrl);
      return [];
    });
    setLineage(null);
    setAgentId(null);
    setForkTurnId(null);
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
        setLineage(data.lineage ?? null);
        setAgentId(data.agent_id ?? null);
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

  // P1-T13: resolve the parent's title for the lineage banner. Delete is a
  // tombstone (openapi.yaml:438-443) — a 404 here means the parent was
  // deleted; the link renders disabled as "parent deleted", never broken.
  const parentId = lineage?.parent_conversation_id;
  useEffect(() => {
    setParent(null);
    if (!parentId) return;
    let cancelled = false;
    api
      .conversation(tree, parentId)
      .then((data) => {
        if (!cancelled) setParent({ title: data.title });
      })
      .catch((e: unknown) => {
        if (!cancelled && e instanceof ApiError && e.status === 404) setParent("deleted");
      });
    return () => {
      cancelled = true;
    };
  }, [tree, parentId]);

  const streaming = stream !== null;
  const uploading = pending.some((p) => p.status === "uploading");

  // Attach flow: picker or drag-drop → immediate POST /upload per file
  // ("multipart upload to /upload before send", feature-spec.md:277). Chips
  // are removable before send (feature-spec.md:12 "attachment chips,
  // removable before send").
  const addFiles = (files: File[]) => {
    for (const file of files) {
      const key = ++pendingKeyRef.current;
      // Tiny client-side thumbnail for images; guarded because jsdom lacks
      // createObjectURL. Contract url stays null in Phase 1 (openapi.yaml:1284).
      const previewUrl =
        file.type.startsWith("image/") && typeof URL.createObjectURL === "function"
          ? URL.createObjectURL(file)
          : undefined;
      setPending((prev) => [
        ...prev,
        { key, filename: file.name, size: file.size, status: "uploading", previewUrl },
      ]);
      api
        .upload(file)
        .then((attachment) => {
          setPending((prev) =>
            prev.map((p) => (p.key === key ? { ...p, status: "done", attachment } : p)),
          );
        })
        .catch((e: unknown) => {
          // 413/oversize etc: surface the server's message on the chip; the
          // file is not added (openapi.yaml:535-536).
          const message = e instanceof Error ? e.message : String(e);
          setPending((prev) =>
            prev.map((p) => (p.key === key ? { ...p, status: "error", error: message } : p)),
          );
        });
    }
  };

  const removePending = (key: number) => {
    setPending((prev) => {
      const found = prev.find((p) => p.key === key);
      if (found?.previewUrl) URL.revokeObjectURL(found.previewUrl);
      return prev.filter((p) => p.key !== key);
    });
  };

  const clearPending = () => {
    setPending((prev) => {
      for (const p of prev) if (p.previewUrl) URL.revokeObjectURL(p.previewUrl);
      return [];
    });
  };

  const send = async () => {
    const text = input.trim();
    // Design choice: send is DISABLED until in-flight uploads settle (rather
    // than queued) — the spec sequences "upload to /upload before send"
    // (feature-spec.md:277) and disabling is the simplest state users can see.
    if (!text || streaming || uploading) return;
    // Only successfully uploaded ids go out (openapi.yaml:1423 "Attachment ids
    // from POST /upload"); error chips are dropped with the rest on send.
    const uploaded = pending.filter((p) => p.status === "done" && p.attachment);
    const attachmentIds = uploaded.map((p) => p.attachment!.id);
    setInput("");
    clearPending();
    setSendError(null);
    const optimistic: Turn = {
      id: `local-${Date.now()}`,
      role: "user",
      author: "user",
      content: text,
      created_at: new Date().toISOString(),
      // Render the user turn's chips immediately, same shape the server will
      // store on Turn.attachments (openapi.yaml:1313-1315).
      attachments: uploaded.map((p) => p.attachment!),
      envelope: null,
    };
    setTurns((prev) => [...(prev ?? []), optimistic]);
    setStream({ draft: "", taskId: null });
    const abort = new AbortController();
    abortRef.current = abort;
    try {
      const result = await api.chat(
        tree,
        {
          message: text,
          conversation_id: conversationId,
          stream: true,
          ...(attachmentIds.length > 0 ? { attachments: attachmentIds } : {}),
          // P1-T05: session-scoped settings "sent with each /chat call"
          // (feature-spec.md:278). ChatSettings keys mirror ChatRequest
          // (openapi.yaml:1425-1430) and unset keys are absent, so the spread
          // sends only what the user set — never null for untouched fields.
          ...chatSettings,
        },
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
      {/* Header per sketches: title left, settings affordance right —
          clean/01-chat.svg header shows a bare "⚙" at the right edge;
          annotated 01-chat.svg shows "model · temp ⚙" in the same spot. */}
      <Group justify="space-between" wrap="nowrap">
        <Title order={4}>{title ?? (conversationId ? " " : "New chat")}</Title>
        <ChatSettingsMenu />
      </Group>
      {/* P1-T13 fork identity banner — "Forks carry lineage metadata: parent
          conversation id, fork turn, endpoint + config used. Shown as a
          badge/breadcrumb" (feature-spec.md:69); "open parent (if fork)"
          (feature-spec.md:6). */}
      {lineage && (
        <Group gap={8} wrap="nowrap" data-testid="lineage-banner">
          <Badge size="xs" variant="light" color="grape">
            ⑂ fork
          </Badge>
          <Text size="xs" c="dimmed" style={{ minWidth: 0 }} truncate>
            fork of{" "}
            {parent === "deleted" || parent == null
              ? lineage.parent_conversation_id
              : parent.title}
            {" @ "}
            {lineage.fork_turn_id}
            {/* endpoint_id shown verbatim — mapping ids to display names would
                cost a GET /endpoints per fork open; acceptable Phase-1 density. */}
            {lineage.endpoint_id ? ` · via ${lineage.endpoint_id}` : ""}
          </Text>
          {parent === "deleted" ? (
            <Text size="xs" c="dimmed" fs="italic">
              parent deleted
            </Text>
          ) : (
            <Anchor
              size="xs"
              onClick={() => navigate(`/chat/${lineage.parent_conversation_id}`)}
            >
              Open parent
            </Anchor>
          )}
          {/* P1-T14 — fork-side entry into the sibling comparison ("compare
              forks of the same turn across endpoints", feature-spec.md:73).
              Lineage alone identifies the sibling set (parent + fork turn),
              so this works even when the parent was deleted; design
              rationale in ForkComparePage.tsx. */}
          <Anchor
            size="xs"
            onClick={() =>
              navigate(`/forks/${lineage.parent_conversation_id}/${lineage.fork_turn_id}`)
            }
          >
            Compare siblings
          </Anchor>
        </Group>
      )}
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
                // ⑂ needs a persisted conversation to re-fire against; a brand
                // new chat gains the id (and the affordance) after the first
                // send navigates to /chat/{id}.
                onFork={conversationId ? () => setForkTurnId(turn.id) : undefined}
                // P1-T16 ⌁ — sketch 01's action row (👍👎⧉⑂⌁). The contract
                // gives user turns traces too (empty spans), but the action
                // row exists on assistant turns only (TurnBubble renders it
                // per feature-spec.md:11), so ⌁ ships there — documented
                // design choice matching the sketch.
                onTrace={() => navigate(`/trace/${turn.id}`)}
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
      {/* P1-T04 composer per sketches/clean/01-chat.svg: pending chips row
          ("📎 spec.pdf ✕") above the input row "+ Message… ↑"; stop replaces
          send in the same slot while streaming. Enter = send, Shift+Enter =
          newline (feature-spec.md:12). Drag-drop uses native handlers — no
          dropzone dependency is installed (package.json has no
          @mantine/dropzone). */}
      <div
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => {
          e.preventDefault();
          addFiles(Array.from(e.dataTransfer.files));
        }}
      >
        {pending.length > 0 && (
          <Group gap={6} mb={6} data-testid="pending-attachments">
            {pending.map((p) => (
              <Paper
                key={p.key}
                px={8}
                py={2}
                radius="sm"
                withBorder
                style={p.status === "error" ? { borderColor: "var(--mantine-color-red-6)" } : undefined}
              >
                <Group gap={6} wrap="nowrap">
                  {p.previewUrl ? (
                    <img
                      src={p.previewUrl}
                      alt=""
                      height={18}
                      style={{ borderRadius: 3, maxWidth: 32, objectFit: "cover" }}
                    />
                  ) : (
                    <Text size="xs">&#x1F4CE;</Text>
                  )}
                  <Text size="xs" c={p.status === "error" ? "red" : undefined}>
                    {p.filename} ({formatBytes(p.size)})
                  </Text>
                  {p.status === "uploading" && <Loader size={12} data-testid="chip-uploading" />}
                  {p.status === "error" && (
                    <Text size="xs" c="red">
                      {p.error}
                    </Text>
                  )}
                  <CloseButton
                    size="xs"
                    aria-label={`Remove ${p.filename}`}
                    onClick={() => removePending(p.key)}
                  />
                </Group>
              </Paper>
            ))}
          </Group>
        )}
        <Group align="flex-end" gap="xs">
          <FileButton multiple onChange={addFiles} inputProps={{ "aria-label": "Attach files input" }}>
            {({ onClick }) => (
              <ActionIcon
                size="lg"
                variant="default"
                aria-label="Attach files"
                onClick={onClick}
              >
                +
              </ActionIcon>
            )}
          </FileButton>
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
            <ActionIcon
              size="lg"
              variant="filled"
              aria-label="Send"
              onClick={() => void send()}
              disabled={!input.trim() || uploading}
            >
              &#x2191;
            </ActionIcon>
          )}
        </Group>
      </div>
      {/* P1-T13 — "🔀 fork action on any turn in Chat itself"
          (feature-spec.md:72); sketch 01 tags the ⑂ glyph with
          "POST …/replay/turn". Modal is mounted once, keyed by the target
          turn; agentId enables its optional version select. */}
      {conversationId && forkTurnId != null && (
        <ForkModal
          conversationId={conversationId}
          turnId={forkTurnId}
          agentId={agentId}
          opened
          onClose={() => setForkTurnId(null)}
        />
      )}
    </Stack>
  );
}

// P1-T05 — chat settings submenu. "Chat has its own Settings submenu (model,
// temperature, system prompt — session-scoped)" (feature-spec.md:7); "sent
// with each /chat call" (feature-spec.md:278). Model options from GET /models
// (feature-spec.md:122), fetched once on first open and cached in AppContext.
// Placement per the sketches' chat header (title left, "⚙" top-right;
// annotated 01-chat.svg shows a "model · temp" summary beside the gear — we
// render that summary only when settings deviate from defaults, doubling as
// the visible "custom settings active" indication alongside the dot badge).
// The annotated sketch tags this "GET/PUT /settings", but /settings is
// deferred to Phase 2 (openapi.yaml:38-40) — Phase 1 keeps the values in
// React state only: they persist across conversation switches within the
// session, not across reloads. Unset = absent key = omitted from ChatRequest.
function ChatSettingsMenu() {
  const { models, ensureModels, chatSettings, setChatSettings } = useApp();
  const [opened, setOpened] = useState(false);
  // NumberInput emits partial strings mid-typing ("0.") — keep the raw value
  // locally so typing isn't clobbered; only committed numbers reach context.
  const [tempRaw, setTempRaw] = useState<number | string>(chatSettings.temperature ?? "");

  // P1-T18c "Live LLM (BYOK)". Hard rule (docs/deployment.md:25): the key
  // lives in "browser localStorage only" — llmKey.ts is the single store;
  // this state MIRRORS it for rendering (badge, section) and never goes to
  // any other sink. deployment.md overrides P1-T05's no-persistence note for
  // this key specifically.
  const [liveKey, setLiveKeyState] = useState<string | null>(() => getLlmKey());
  const [keyDraft, setKeyDraft] = useState("");
  const [byokModel, setByokModelState] = useState<string | null>(() => getLlmModel());
  // Curated live list — refetched via GET /models WITH the key header (the
  // client attaches it centrally once the key is stored), "populated from a
  // curated cheap-model list in live mode" (docs/deployment.md:22-23).
  const [liveModels, setLiveModels] = useState<Model[] | null>(null);

  const saveKey = () => {
    const key = keyDraft.trim();
    if (!key) return;
    setLlmKey(key); // localStorage only (docs/deployment.md:25)
    setLiveKeyState(key);
    setKeyDraft("");
    api.models().then(setLiveModels).catch(() => setLiveModels(null));
  };
  const clearKey = () => {
    setLlmKey(null);
    setLlmModel(null);
    setLiveKeyState(null);
    setByokModelState(null);
    setLiveModels(null);
  };
  const pickByokModel = (value: string | null) => {
    setLlmModel(value);
    setByokModelState(value);
  };

  const dirty = Object.values(chatSettings).some((v) => v !== undefined);
  const patch = (p: Partial<ChatSettings>) =>
    setChatSettings((prev) => {
      const next = { ...prev, ...p };
      for (const k of Object.keys(next) as (keyof ChatSettings)[]) {
        if (next[k] === undefined) delete next[k];
      }
      return next;
    });
  const reset = () => {
    setChatSettings({});
    setTempRaw("");
  };

  const modelName =
    models?.find((m) => m.id === chatSettings.model)?.name ?? chatSettings.model;
  const summary = [
    modelName,
    chatSettings.temperature !== undefined ? `temp ${chatSettings.temperature}` : undefined,
    chatSettings.system_prompt !== undefined ? "sys prompt" : undefined,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <Group gap={6} wrap="nowrap">
      {dirty && (
        <Text size="xs" c="dimmed" data-testid="chat-settings-summary">
          {summary}
        </Text>
      )}
      {/* Visible "live" indicator while a BYOK key is active (P1-T18c) —
          generation is going to a real provider, not the canned mock. */}
      {liveKey && (
        <Badge size="xs" color="green" variant="light" data-testid="live-badge">
          live
        </Badge>
      )}
      <Popover opened={opened} onChange={setOpened} position="bottom-end" shadow="md">
        <Popover.Target>
          <Indicator disabled={!dirty} color="blue" size={8} offset={2}>
            <ActionIcon
              variant="subtle"
              color="gray"
              aria-label="Chat settings"
              onClick={() => {
                ensureModels();
                if (liveKey && !liveModels) {
                  api.models().then(setLiveModels).catch(() => {});
                }
                setTempRaw(chatSettings.temperature ?? "");
                setOpened((o) => !o);
              }}
            >
              &#x2699;
            </ActionIcon>
          </Indicator>
        </Popover.Target>
        <Popover.Dropdown>
          <Stack gap="xs" w={260}>
            {/* Model dropdown fed by GET /models (feature-spec.md:122);
                clearable back to the backend default. Combobox kept inside
                the popover DOM so option clicks don't count as outside. */}
            <Select
              label="Model"
              placeholder="Default"
              data={models?.map((m) => ({ value: m.id, label: m.name })) ?? []}
              value={chatSettings.model ?? null}
              onChange={(value) => patch({ model: value ?? undefined })}
              clearable
              comboboxProps={{ withinPortal: false }}
            />
            {/* Number input over slider: the sketch header is dense and a
                slider cannot represent "unset"; bounds 0-2, empty = unset. */}
            <NumberInput
              label="Temperature"
              placeholder="Default"
              min={0}
              max={2}
              step={0.1}
              decimalScale={2}
              value={tempRaw}
              onChange={(value) => {
                setTempRaw(value);
                patch({ temperature: typeof value === "number" ? value : undefined });
              }}
            />
            <Textarea
              label="System prompt"
              placeholder="Default"
              autosize
              minRows={2}
              maxRows={6}
              value={chatSettings.system_prompt ?? ""}
              onChange={(e) =>
                patch({ system_prompt: e.currentTarget.value || undefined })
              }
            />
            <Button variant="default" size="xs" onClick={reset} disabled={!dirty}>
              Reset to defaults
            </Button>
            {/* P1-T18c — "Live LLM (BYOK)". Key → localStorage ONLY
                (docs/deployment.md:25); sent per request as X-LLM-Key
                (+ X-LLM-Model) by the api client, never in URLs, never
                logged (docs/deployment.md:26-27). */}
            <Divider label="Live LLM (BYOK)" labelPosition="left" my={2} />
            {liveKey ? (
              <>
                <Group gap={6} wrap="nowrap">
                  <Text size="xs" c="dimmed" style={{ flex: 1 }}>
                    OpenRouter key active (stored in this browser only).
                  </Text>
                  <Button size="xs" color="red" variant="light" onClick={clearKey}>
                    Clear key
                  </Button>
                </Group>
                <Select
                  label="Live model"
                  placeholder="Provider default"
                  data={liveModels?.map((m) => ({ value: m.id, label: m.name })) ?? []}
                  value={byokModel}
                  onChange={pickByokModel}
                  clearable
                  comboboxProps={{ withinPortal: false }}
                />
              </>
            ) : (
              <>
                <PasswordInput
                  label="OpenRouter key"
                  placeholder="sk-or-…"
                  value={keyDraft}
                  onChange={(e) => setKeyDraft(e.currentTarget.value)}
                />
                <Button size="xs" variant="default" onClick={saveKey} disabled={!keyDraft.trim()}>
                  Save key
                </Button>
              </>
            )}
          </Stack>
        </Popover.Dropdown>
      </Popover>
    </Group>
  );
}

function TurnBubble({
  turn,
  thumb,
  onRate,
  onFork,
  onTrace,
}: {
  turn: Turn;
  thumb?: Rating;
  onRate: (rating: Rating) => void;
  onFork?: () => void;
  onTrace?: () => void;
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
        {/* P1-T11a envelope affordance. loom-phases.md:25: "every turn records
            its context (date, timezone, region) at generation". Sketch 01
            shows no envelope UI, so the surface is deliberately minimal — a
            hover tooltip on the timestamp (dotted underline = discoverable),
            showing the EnvelopeChip reused later by the T16 trace header. */}
        <Tooltip label={<EnvelopeChip envelope={turn.envelope} />} p={4}>
          <Text
            size="xs"
            c="dimmed"
            style={{ cursor: "help", textDecoration: "underline dotted" }}
          >
            {new Date(turn.created_at).toLocaleString()}
          </Text>
        </Tooltip>
      </Group>
      {/* Stored attachments render as filename chips (Turn.attachments,
          openapi.yaml:1313-1315; url is null in Phase 1 so no link). */}
      {turn.attachments && turn.attachments.length > 0 && (
        <Group gap={4} mb={4}>
          {turn.attachments.map((a) => (
            <Badge key={a.id} variant="light" color="gray" radius="sm" tt="none">
              &#x1F4CE; {a.filename}
            </Badge>
          ))}
        </Group>
      )}
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
          {/* P1-T13 ⑂ — sketch 01 action row "👍👎 ⑂ ⌁" with the fork glyph
              tagged "POST …/replay/turn"; trace ⌁ remains P1-T16. */}
          {onFork && (
            <ActionIcon
              size="sm"
              variant="subtle"
              color="gray"
              aria-label="Fork turn"
              onClick={onFork}
            >
              ⑂
            </ActionIcon>
          )}
          {/* P1-T16 ⌁ — "⌁ trace icon on every turn — in Chat, results grid
              cells, and drill-in" (feature-spec.md:145); routes to the trace
              view (sketch 08). */}
          {onTrace && (
            <ActionIcon
              size="sm"
              variant="subtle"
              color="gray"
              aria-label="Open trace"
              onClick={onTrace}
            >
              ⌁
            </ActionIcon>
          )}
        </Group>
      )}
    </Paper>
  );
}
