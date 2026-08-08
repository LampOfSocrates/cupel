// The in-flight draft is an EXTERNAL STORE, not page state: as ChatPage state,
// every token re-rendered the whole page — transcript, composer, header — so a
// stream cost O(turns) per token instead of O(1) (docs/review-2026-08-05.md
// A8). Only <StreamingBubble> subscribes, so a token re-renders one bubble.
// ChatPage keeps "a stream is running" + its task id, which change three times
// per stream (start, task event, done), not once per token.
export function createDraftStore() {
  let text = "";
  const listeners = new Set<() => void>();
  const emit = () => {
    for (const listener of listeners) listener();
  };
  return {
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    get: () => text,
    append(delta: string) {
      text += delta;
      emit();
    },
    reset() {
      text = "";
      emit();
    },
  };
}

export type DraftStore = ReturnType<typeof createDraftStore>;
