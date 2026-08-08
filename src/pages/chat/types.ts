// Shapes shared by the chat page and the components it composes.

export interface StreamState {
  taskId: string | null; // null until the `task` event arrives
}

// Session-scoped chat settings: "Chat has its own Settings submenu (model,
// temperature, system prompt — session-scoped)" (feature-spec.md:7); "sent
// with each /chat call" (feature-spec.md:278). Session-scoped = React state
// for the app session: survives conversation switches, NOT reloads — Phase 1
// has no /settings endpoint (openapi.yaml:38-40 lists it under "Deferred to
// later phases") and no localStorage persistence is specced.
// Keys mirror ChatRequest field names (openapi.yaml:1425-1430) so the send
// spreads them straight into the body; unset settings are ABSENT keys — the
// contract fields are nullable but untouched settings are omitted entirely,
// never sent as null.
export interface ChatSettings {
  model?: string;
  temperature?: number;
  system_prompt?: string;
}

export type Rating = "up" | "down";

// A thumb plus the optional note the rater left with it. The note is NOT a
// Turn — turns are what gets replayed, forked and judged, and Turn.role is
// user|assistant — so it lives on the human judgment (FeedbackRequest.comment
// → Judgment.reasoning) and renders under its turn.
export interface ThumbState {
  rating: Rating;
  comment: string | null;
}
