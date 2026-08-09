import { useEffect, useEffectEvent, useRef, useState } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router";
import { Alert, Anchor, Badge, Button, Group, Stack, Text, Title } from "@mantine/core";
import { api, ApiError } from "../api/client";
import { getSseEnabled } from "../api/backendPrefs";
import type {
  Attachment,
  CasebookItemCreate,
  Judgment,
  Lineage,
  Turn,
} from "../api/types";
import { ForkModal } from "../components";
import { CollectModal } from "../components/CollectModal";
import { ReadOnlyTreeBanner } from "../shell/ReadOnlyTreeBanner";
import { useAsync } from "../hooks/useAsync";
import { useApp } from "../AppContext";
import { TURN_PARAM, turnShareUrl } from "../lib/shareLink";
import { ChatSettingsMenu } from "./chat/ChatSettingsMenu";
import { CompareToggle, CompareView } from "./chat/CompareView";
import { Composer } from "./chat/Composer";
import { createDraftStore } from "./chat/draftStore";
import { Transcript } from "./chat/Transcript";
import type { ChatSettings, Rating, StreamState, ThumbState } from "./chat/types";

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

// Per-turn thumb state from judgment history. Judgments arrive "newest first"
// (openapi.yaml:994) and are append-only, so the current thumb is the FIRST
// type:human judgment per turn_id; "For type human, 1 = 👍 and 0 = 👎"
// (openapi.yaml:1905). That judgment's reasoning comes along under the same
// newest-wins rule — a later bare thumb supersedes an earlier comment, because
// it IS the newer judgment.
function deriveThumbs(judgments: Judgment[]): Record<string, ThumbState> {
  const thumbs: Record<string, ThumbState> = {};
  for (const j of judgments) {
    if (j.type !== "human" || !j.turn_id || j.turn_id in thumbs) continue;
    thumbs[j.turn_id] = {
      rating: j.score === 1 ? "up" : "down",
      comment: j.reasoning ?? null,
    };
  }
  return thumbs;
}

export function ChatPage() {
  const { conversationId } = useParams();
  const { tree, refreshConversations } = useApp();
  const navigate = useNavigate();
  // A received turn link: /chat/{id}?turn={turnId}. Read-only here; the param
  // is never written back, so the URL a receiver shares onward is
  // byte-identical to the one they got.
  const [searchParams] = useSearchParams();
  const sharedTurnId = searchParams.get(TURN_PARAM);

  const [turns, setTurns] = useState<Turn[] | null>(conversationId ? null : []);
  const [title, setTitle] = useState<string | null>(null);
  // Lineage + agent off the loaded Conversation. Lineage is "Present iff this
  // conversation is a fork" (openapi.yaml:1369) and drives the header banner;
  // agent_id seeds the fork modal's optional version select.
  const [lineage, setLineage] = useState<Lineage | null>(null);
  const [agentId, setAgentId] = useState<string | null>(null);
  // ⑂ target — assistant turn id the fork modal is open for (null = closed).
  const [forkTurnId, setForkTurnId] = useState<string | null>(null);
  // ⊞ — the turn a collect dialog is open for (CasebookItemCreate, the POST
  // body of openapi.yaml:1732-1757).
  const [collectTarget, setCollectTarget] = useState<CasebookItemCreate | null>(null);
  const [loadError, setLoadError] = useState<Error | null>(null);
  const [stream, setStream] = useState<StreamState | null>(null);
  // Lazy init: one store per ChatPage instance, stable for its lifetime.
  const [draft] = useState(createDraftStore);
  const [sendError, setSendError] = useState<string | null>(null);
  const [thumbs, setThumbs] = useState<Record<string, ThumbState>>({});
  // Turn id whose comment box is open (null = none). Only ever one — a thumb
  // elsewhere moves the box rather than stacking prompts.
  const [commentFor, setCommentFor] = useState<string | null>(null);
  // Session-scoped chat settings (feature-spec.md:7, :278). They live HERE,
  // not in AppContext: only this page reads them, and in the context every
  // keystroke in the settings popover re-rendered the entire app
  // (docs/review-2026-08-05.md A5). Session scope still holds — this
  // component instance survives /chat ↔ /chat/:id (the route pair renders the
  // same element, so React keeps the instance and its state across the
  // post-send navigate).
  const [chatSettings, setChatSettings] = useState<ChatSettings>({});
  // Bumped when we leave a conversation: the composer drops the chips (and
  // their image previews) that were picked for the transcript being left.
  const [composerReset, setComposerReset] = useState(0);
  // A/B compare mode (docs/plan-ab-compare.md §3) — a second LAYOUT for the
  // same conversation, not a second page. Off is the whole of normal chat.
  const [compare, setCompare] = useState(false);
  // Conversation the compare send landed in. Compare owns its own send, so it
  // never navigates mid-mode; leaving the mode is what re-enters the single
  // transcript ("Leaving compare mode returns to a normal single
  // conversation", plan §3) and the route change refetches it.
  const compareConvRef = useRef<string | null>(null);

  // Conversation id whose turns the local state already holds — set when a
  // send attaches to it (via the SSE `task` event) or when a GET completes.
  // Lets the post-send navigate skip a refetch that would wipe the stream.
  const attachedConvRef = useRef<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  // Auto-scroll pinned to bottom unless the user scrolled up
  // (feature-spec.md:13 "Auto-scroll on stream"). The transcript does the
  // scrolling; the page owns the refs because the share-link effect below
  // aims them too.
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const pinnedRef = useRef(true);

  // Share-link highlight. Design (documented choice): the targeted turn keeps
  // a PERSISTENT left accent marker (data-share-target) for the whole visit —
  // a receiver who scrolls away can still find the spot — plus a brief ring
  // that fades after ~2.5s so the eye catches it on arrival. Nothing about
  // the transcript is mutated, so the rest of the page behaves normally.
  const sharedRef = useRef<HTMLDivElement | null>(null);
  const [sharedFlash, setSharedFlash] = useState(false);
  // The load effect below must NOT re-run when only ?turn= changes, yet it
  // needs that param's current value to decide the initial scroll pin — which
  // is exactly what an effect event reads without joining a dependency list.
  const pinUnlessSharedTarget = useEffectEvent(() => {
    pinnedRef.current = sharedTurnId === null;
  });
  const sharedHandledRef = useRef<string | null>(null);
  // Unknown turn id → no target at all: the conversation just renders normally
  // (task rule: ignore gracefully, never an error).
  const sharedTurnPresent =
    sharedTurnId !== null && (turns?.some((t) => t.id === sharedTurnId) ?? false);
  useEffect(() => {
    if (!sharedTurnPresent || sharedHandledRef.current === sharedTurnId) return;
    sharedHandledRef.current = sharedTurnId;
    // The explicit target owns the initial scroll position — beat the
    // bottom-pin for this load (the pin re-arms as soon as the user scrolls
    // back down, via the transcript's onScroll).
    pinnedRef.current = false;
    sharedRef.current?.scrollIntoView({ block: "center" });
    setSharedFlash(true);
    const timer = setTimeout(() => setSharedFlash(false), 2500);
    return () => clearTimeout(timer);
  }, [sharedTurnPresent, sharedTurnId]);

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
    setComposerReset((n) => n + 1);
    setLineage(null);
    setAgentId(null);
    setForkTurnId(null);
    // An open comment box belongs to the turn we're leaving.
    setCommentFor(null);
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
    // Arriving on a ?turn= deep link, do NOT pin to the bottom for this load —
    // the highlight effect above places the viewport instead.
    pinUnlessSharedTarget();
    sharedHandledRef.current = null;
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
      .catch((e: Error) => {
        if (!cancelled) setLoadError(e);
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

  // Unmount: abort an in-flight stream. (The composer releases its own image
  // previews, docs/review-2026-08-05.md A7.)
  useEffect(
    () => () => {
      abortRef.current?.abort();
    },
    [],
  );

  // Resolve the parent's title for the lineage banner. Delete is a tombstone
  // (openapi.yaml:438-443) — a 404 here means the parent was deleted; the link
  // renders disabled as "parent deleted", never broken. Any OTHER failure is
  // swallowed to `null`, which renders exactly as "still loading": a banner
  // that cannot name its parent is not worth an error state.
  const parentId = lineage?.parent_conversation_id;
  const { data: parent } = useAsync<{ title: string } | "deleted" | null>(
    parentId
      ? () =>
          api
            .conversation(tree, parentId)
            .then((data) => ({ title: data.title }) as { title: string } | "deleted" | null)
            .catch((e: unknown) =>
              e instanceof ApiError && e.status === 404 ? "deleted" : null,
            )
      : null,
    [tree, parentId],
  );

  const streaming = stream !== null;

  const send = async (text: string, uploaded: Attachment[]) => {
    // Only successfully uploaded ids go out (openapi.yaml:1423 "Attachment ids
    // from POST /upload").
    const attachmentIds = uploaded.map((a) => a.id);
    setSendError(null);
    const optimistic: Turn = {
      id: `local-${Date.now()}`,
      role: "user",
      author: "user",
      content: text,
      created_at: new Date().toISOString(),
      // Render the user turn's chips immediately, same shape the server will
      // store on Turn.attachments (openapi.yaml:1313-1315).
      attachments: uploaded,
      envelope: null,
    };
    setTurns((prev) => [...(prev ?? []), optimistic]);
    draft.reset();
    setStream({ taskId: null });
    const abort = new AbortController();
    abortRef.current = abort;
    try {
      const result = await api.chat(
        tree,
        {
          message: text,
          conversation_id: conversationId,
          // The Settings → Backend "SSE streaming on/off" mock option
          // (feature-spec.md:160) — device-local flag, read at send time.
          // stream:false answers a single JSON ChatResponse handled below
          // (cupel-phases.md:43 "the UI degrades gracefully to non-streaming
          // when the SSE toggle is off in mock options").
          stream: getSseEnabled(),
          ...(attachmentIds.length > 0 ? { attachments: attachmentIds } : {}),
          // Session-scoped settings "sent with each /chat call"
          // (feature-spec.md:278). ChatSettings keys mirror ChatRequest
          // (openapi.yaml:1425-1430) and unset keys are absent, so the spread
          // sends only what the user set — never null for untouched fields.
          ...chatSettings,
        },
        { signal: abort.signal },
      );
      if (result.kind === "json") {
        // Backend degraded to a single JSON ChatResponse (cupel-phases.md:43)
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
            // Straight to the draft store — no page render (A8).
            draft.append(ev.data.delta);
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
  // The rating is submitted on the click ITSELF — a user who only wants to
  // rate still does exactly one click — and the comment box is merely revealed
  // alongside it. The new judgment carries no comment, so the rendered note
  // clears until one is submitted (newest judgment wins).
  const rate = (turnId: string, rating: Rating) => {
    const previous = thumbs[turnId];
    setThumbs((m) => ({ ...m, [turnId]: { rating, comment: null } }));
    setCommentFor(turnId);
    api.postFeedback({ message_id: turnId, rating }).catch(() => {
      // Revert the optimistic thumb — the judgment was never appended.
      setThumbs((m) => {
        const next = { ...m };
        if (previous === undefined) delete next[turnId];
        else next[turnId] = previous;
        return next;
      });
      setCommentFor((open) => (open === turnId ? null : open));
    });
  };

  // The comment is a SECOND feedback post carrying the same rating plus the
  // note — an append, never an update (there is no judgment PATCH,
  // openapi.yaml /eval/judgments is GET-only). Newest-wins in deriveThumbs
  // then makes this judgment the one that renders.
  const submitComment = (turnId: string, text: string) => {
    const comment = text.trim();
    const previous = thumbs[turnId];
    if (!comment || !previous) return;
    setThumbs((m) => ({ ...m, [turnId]: { rating: previous.rating, comment } }));
    setCommentFor(null);
    api
      .postFeedback({ message_id: turnId, rating: previous.rating, comment })
      .catch(() => {
        // Nothing was appended — fall back to the thumb-only judgment.
        setThumbs((m) => ({ ...m, [turnId]: previous }));
      });
  };

  if (loadError) {
    // No-access state. The contract makes "deleted" and "you may not see this
    // conversation" INDISTINGUISHABLE — both answer 404 (openapi.yaml:1948
    // NotFound) — so one friendly state covers both and deliberately says
    // nothing about which. Any other failure keeps the existing red error
    // surface carrying the backend's message.
    if (loadError instanceof ApiError && loadError.status === 404) {
      return (
        <Stack gap="sm" maw={420} mx="auto" mt="xl" data-testid="conversation-unavailable">
          <Alert color="gray" title="This conversation isn't available">
            It may have been deleted, or you may not have access.
          </Alert>
          <Button variant="default" size="xs" onClick={() => navigate("/chat")}>
            Start a new chat
          </Button>
        </Stack>
      );
    }
    return <Alert color="red" title="Could not load conversation">{loadError.message}</Alert>;
  }

  return (
    // The page owns a viewport-height column so the composer sits at the
    // bottom and only the transcript scrolls. Two portrait fixes: dvh (100vh
    // is the LARGE viewport on phones, so the composer hid behind the
    // browser's own bottom chrome), and subtracting the AppShell header offset
    // (banner + burger bar), which the old 100vh never accounted for — the
    // composer sat exactly that far below the fold.
    <Stack
      gap="sm"
      maw={760}
      mx="auto"
      h="calc(100dvh - var(--app-shell-header-offset, 0rem) - 2 * var(--mantine-spacing-md))"
    >
      {/* Header per sketches: title left, settings affordance right —
          clean/01-chat.svg header shows a bare "⚙" at the right edge;
          annotated 01-chat.svg shows "model · temp ⚙" in the same spot. */}
      <Group justify="space-between" wrap="nowrap">
        {/* lineClamp + minWidth:0 — a long title truncates instead of shoving
            the ⚙ off a phone screen. */}
        <Title order={4} lineClamp={1} style={{ minWidth: 0 }}>{title ?? (conversationId ? " " : "New chat")}</Title>
        <Group gap="xs" wrap="nowrap">
          <CompareToggle
            enabled={compare}
            onChange={(on) => {
              setCompare(on);
              if (on) return;
              const landed = compareConvRef.current;
              compareConvRef.current = null;
              if (landed && landed !== conversationId) navigate(`/chat/${landed}`);
            }}
          />
          <ChatSettingsMenu settings={chatSettings} onChange={setChatSettings} />
        </Group>
      </Group>
      {/* A disabled tree keeps history readable while every new turn 409s
          (feature-spec.md:20 "read-only banner"). */}
      <ReadOnlyTreeBanner />
      {/* Fork identity banner — "Forks carry lineage metadata: parent
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
          {/* Fork-side entry into the sibling comparison ("compare forks of
              the same turn across endpoints", feature-spec.md:73). Lineage
              alone identifies the sibling set (parent + fork turn), so this
              works even when the parent was deleted; design rationale in
              ForkComparePage.tsx. */}
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
      {compare ? (
        <CompareView
          // Remount on conversation switch: each transcript compares its own
          // shared turn.
          key={conversationId ?? "new"}
          conversationId={conversationId ?? null}
          chatSettings={chatSettings}
          onConversation={(id) => {
            compareConvRef.current = id;
            refreshConversations();
          }}
        />
      ) : (
        <>
        <Transcript
          turns={turns}
          stream={stream}
          draft={draft}
          scrollRef={scrollRef}
          pinnedRef={pinnedRef}
          thumbs={thumbs}
          commentFor={commentFor}
          sendError={sendError}
          onRate={rate}
          onComment={submitComment}
          onDismissComment={() => setCommentFor(null)}
          onFork={conversationId ? setForkTurnId : undefined}
          onTrace={(turnId) => navigate(`/trace/${turnId}`)}
          // An item is a REFERENCE {tree, conversation_id, turn_id}, so there is
          // nothing to point at until the first send lands.
          onCollect={
            conversationId
              ? (turnId) =>
                  setCollectTarget({ tree, conversation_id: conversationId, turn_id: turnId })
              : undefined
          }
          shareUrlFor={
            conversationId ? (turnId) => turnShareUrl(conversationId, turnId) : undefined
          }
          sharedTurnId={sharedTurnId}
          sharedTurnPresent={sharedTurnPresent}
          sharedFlash={sharedFlash}
          sharedRef={sharedRef}
        />
        <Composer
          streaming={streaming}
          canStop={stream?.taskId != null}
          onStop={stop}
          onSend={(text, attachments) => void send(text, attachments)}
          resetToken={composerReset}
        />
        </>
      )}
      {/* "🔀 fork action on any turn in Chat itself" (feature-spec.md:72);
          sketch 01 tags the ⑂ glyph with "POST …/replay/turn". Modal is
          mounted once, keyed by the target turn; agentId enables its optional
          version select. */}
      {conversationId && forkTurnId != null && (
        <ForkModal
          conversationId={conversationId}
          turnId={forkTurnId}
          agentId={agentId}
          opened
          onClose={() => setForkTurnId(null)}
        />
      )}
      {/* ⊞ — the same picker the Inspector uses (create-new inline). */}
      <CollectModal
        opened={collectTarget !== null}
        target={collectTarget}
        onClose={() => setCollectTarget(null)}
      />
    </Stack>
  );
}
