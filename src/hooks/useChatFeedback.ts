import { useState, useCallback, Dispatch, SetStateAction } from "react";
import { api } from "../api/client";
import type { Rating, ThumbState } from "../pages/chat/types";

export interface UseChatFeedback {
  thumbs: Record<string, ThumbState>;
  setThumbs: Dispatch<SetStateAction<Record<string, ThumbState>>>;
  commentFor: string | null;
  setCommentFor: Dispatch<SetStateAction<string | null>>;
  rate: (turnId: string, rating: Rating) => void;
  submitComment: (turnId: string, text: string) => void;
}

/**
 * Custom hook to isolate and manage user feedback (thumbs and comment submissions)
 * inside the ChatPage component, separating concerns and lowering page complexity.
 */
export function useChatFeedback(): UseChatFeedback {
  const [thumbs, setThumbs] = useState<Record<string, ThumbState>>({});
  const [commentFor, setCommentFor] = useState<string | null>(null);

  // 👍/👎 → POST /feedback {message_id, rating} (openapi.yaml:1475-1480;
  // feature-spec.md:272). Optimistic; judgments are append-only (no un-vote
  // endpoint), so re-clicking the same thumb simply appends again.
  // The rating is submitted on the click ITSELF — a user who only wants to
  // rate still does exactly one click — and the comment box is merely revealed
  // alongside it. The new judgment carries no comment, so the rendered note
  // clears until one is submitted (newest judgment wins).
  const rate = useCallback((turnId: string, rating: Rating) => {
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
  }, [thumbs]);

  // The comment is a SECOND feedback post carrying the same rating plus the
  // note — an append, never an update (there is no judgment PATCH,
  // openapi.yaml /eval/judgments is GET-only). Newest-wins in deriveThumbs
  // then makes this judgment the one that renders.
  const submitComment = useCallback((turnId: string, text: string) => {
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
  }, [thumbs]);

  return {
    thumbs,
    setThumbs,
    commentFor,
    setCommentFor,
    rate,
    submitComment,
  };
}
