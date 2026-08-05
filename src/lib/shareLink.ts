// P2-SHARE — copy-link sharing (free tier). Deliberately CONTRACT-NEUTRAL:
// a share link is just one of the app's own routes rendered absolute, so it
// rides the existing GET endpoints and adds nothing to openapi.yaml. The
// receiver authenticates normally and the backend's own rule decides what
// they see — "404 for a conversation that is missing OR unpermitted"
// (openapi.yaml:1948), which ChatPage renders as one no-access state.
//
// Anonymous tokenized public links (expiry, revocation) are PRO-2
// (TASKS.md:67) and are NOT built here.

/** Query param carrying the targeted turn on a conversation deep link. */
export const TURN_PARAM = "turn";

// Current origin, so a link copied from the Render demo points at the demo
// and one copied from localhost points at localhost. No hostname is ever
// configured for sharing — there is nothing to keep in sync.
function currentOrigin(): string {
  return typeof window === "undefined" ? "" : window.location.origin;
}

/** Absolute URL to a conversation: `https://host/chat/{conversationId}`. */
export function conversationShareUrl(conversationId: string): string {
  return `${currentOrigin()}/chat/${encodeURIComponent(conversationId)}`;
}

/** Absolute URL to one turn: `https://host/chat/{conversationId}?turn={turnId}`. */
export function turnShareUrl(conversationId: string, turnId: string): string {
  return `${conversationShareUrl(conversationId)}?${TURN_PARAM}=${encodeURIComponent(turnId)}`;
}
