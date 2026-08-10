import { useEffect, useSyncExternalStore, type RefObject } from "react";
import { Alert, Button, Center, Loader, Paper, Stack, Text } from "@mantine/core";
import type { Turn } from "../../api/types";
import { Markdown } from "../../lib/markdown";
import type { DraftStore } from "./draftStore";
import { TurnBubble } from "./TurnBubble";
import type { Rating, StreamState, ThumbState } from "./types";

// The scrolling message list: history, the in-flight draft and the inline
// generation error, in one bottom-pinned viewport ("Auto-scroll on stream",
// feature-spec.md:13). The scroll container and its pin flag are owned by the
// page, which also aims them at a shared ?turn= target on arrival.
export function Transcript({
  turns,
  onLoadEarlier,
  stream,
  draft,
  scrollRef,
  pinnedRef,
  thumbs,
  commentFor,
  sendError,
  onRate,
  onComment,
  onDismissComment,
  onFork,
  onTrace,
  onCollect,
  shareUrlFor,
  sharedTurnId,
  sharedTurnPresent,
  sharedFlash,
  sharedRef,
}: {
  turns: Turn[] | null;
  /**
   * Present when the transcript on screen starts partway in — listTurns is
   * paged and opens on the LAST page, so a long conversation renders its tail
   * first. Absent means the first turn shown really is the first turn.
   */
  onLoadEarlier?: () => void;
  stream: StreamState | null;
  draft: DraftStore;
  scrollRef: RefObject<HTMLDivElement | null>;
  pinnedRef: RefObject<boolean>;
  thumbs: Record<string, ThumbState>;
  commentFor: string | null;
  sendError: string | null;
  onRate: (turnId: string, rating: Rating) => void;
  onComment: (turnId: string, text: string) => void;
  onDismissComment: () => void;
  onFork?: (turnId: string) => void;
  onTrace: (turnId: string) => void;
  onCollect?: (turnId: string) => void;
  shareUrlFor?: (turnId: string) => string;
  sharedTurnId: string | null;
  sharedTurnPresent: boolean;
  sharedFlash: boolean;
  sharedRef: RefObject<HTMLDivElement | null>;
}) {
  // Tokens scroll from inside StreamingBubble, which owns them; this covers
  // new turns and stream start/end.
  useEffect(() => {
    const el = scrollRef.current;
    if (el && pinnedRef.current) el.scrollTop = el.scrollHeight;
  }, [turns, stream, scrollRef, pinnedRef]);

  return (
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
          {onLoadEarlier && (
            <Button
              variant="subtle"
              size="compact-xs"
              data-testid="load-earlier-turns"
              onClick={onLoadEarlier}
            >
              Load earlier turns
            </Button>
          )}
          {turns.length === 0 && stream === null && (
            <Text c="dimmed" ta="center" mt="xl">
              Send a message to start the conversation.
            </Text>
          )}
          {turns.map((turn) => (
            <TurnBubble
              key={turn.id}
              turn={turn}
              thumb={thumbs[turn.id]?.rating}
              onRate={(rating) => onRate(turn.id, rating)}
              // The note left with the current thumb, plus the box that
              // collects it right after a rating.
              comment={thumbs[turn.id]?.comment ?? null}
              commentOpen={commentFor === turn.id}
              onComment={(text) => onComment(turn.id, text)}
              onDismissComment={onDismissComment}
              // ⑂, ⊞ and 🔗 need a persisted conversation to point at; a brand
              // new chat gains the id (and the affordances) after the first
              // send navigates to /chat/{id}.
              onFork={onFork && (() => onFork(turn.id))}
              // The contract gives user turns traces too (empty spans), but the
              // action row exists on assistant turns only (TurnBubble renders
              // it per feature-spec.md:11), so ⌁ ships there — documented
              // design choice matching sketch 01.
              onTrace={() => onTrace(turn.id)}
              onCollect={onCollect && (() => onCollect(turn.id))}
              shareUrl={shareUrlFor?.(turn.id)}
              shareTarget={sharedTurnPresent && turn.id === sharedTurnId}
              shareFlash={sharedFlash}
              shareRef={turn.id === sharedTurnId ? sharedRef : undefined}
            />
          ))}
          {stream && (
            <StreamingBubble draft={draft} scrollRef={scrollRef} pinnedRef={pinnedRef} />
          )}
          {sendError && (
            <Alert color="red" title="Generation failed">
              {sendError}
            </Alert>
          )}
        </Stack>
      )}
    </div>
  );
}

// The in-flight assistant bubble (openapi.yaml:466-476 token events). It owns
// the draft by subscribing to the store, so a token re-renders THIS and
// nothing else (docs/review-2026-08-05.md A8) — with the memoized Markdown
// (A4) a token's cost is one parse, independent of transcript length.
// Auto-scroll lives here for the same reason: the effect above no longer sees
// per-token change ("Auto-scroll on stream", feature-spec.md:13).
function StreamingBubble({
  draft,
  scrollRef,
  pinnedRef,
}: {
  draft: DraftStore;
  scrollRef: RefObject<HTMLDivElement | null>;
  pinnedRef: RefObject<boolean>;
}) {
  const text = useSyncExternalStore(draft.subscribe, draft.get);
  useEffect(() => {
    const el = scrollRef.current;
    if (el && pinnedRef.current) el.scrollTop = el.scrollHeight;
  }, [text, scrollRef, pinnedRef]);
  return (
    <Paper p="sm" radius="md" withBorder mr="10%" data-testid="streaming-turn">
      {text === "" ? <Loader size="xs" type="dots" /> : <Markdown content={text} />}
    </Paper>
  );
}
