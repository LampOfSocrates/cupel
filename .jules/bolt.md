## 2026-08-06 - Memoizing Chat Transcript Turn Bubbles

**Learning:** In chat applications with active token streaming (e.g., SSE or external draft stores), the parent component re-renders on every streamed token update. Unmemoized transcript message bubbles (such as `TurnBubble`) force React to re-render every historical turn bubble in the conversation on every single token arrival, incurring significant main thread rendering overhead for long chat histories.
**Action:** Wrap transcript message item components in `React.memo` (or `memo`) so React skips re-rendering unchanged historical turns when new tokens stream into the active response bubble or when draft state updates.
