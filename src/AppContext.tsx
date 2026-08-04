import { createContext, useContext, type Dispatch, type SetStateAction } from "react";
import type { AgentTree, Me, Model } from "./api/types";

// P1-T05: "Chat has its own Settings submenu (model, temperature, system
// prompt — session-scoped)" (feature-spec.md:7); "sent with each /chat call"
// (feature-spec.md:278). Session-scoped = React state for the app session:
// survives conversation switches, NOT reloads — Phase 1 has no /settings
// endpoint (openapi.yaml:38-40 lists it under "Deferred to later phases") and
// no localStorage persistence is specced.
// Keys mirror ChatRequest field names (openapi.yaml:1425-1430) so the send
// spreads them straight into the body; unset settings are ABSENT keys — the
// contract fields are nullable but untouched settings are omitted entirely,
// never sent as null.
export interface ChatSettings {
  model?: string;
  temperature?: number;
  system_prompt?: string;
}

export interface AppState {
  me: Me;
  trees: AgentTree[];
  tree: string; // current tree id — defaults to agent1
  // Sidebar refresh signal: chat sends that create/update conversations bump
  // the version so ConversationList reloads (feature-spec.md:5 recent list).
  conversationsVersion: number;
  refreshConversations: () => void;
  // GET /models result, fetched once on first use and cached for the session
  // (feature-spec.md:122 "chat/run/judge model dropdowns" — Runs reuses it).
  models: Model[] | null;
  ensureModels: () => void;
  chatSettings: ChatSettings;
  setChatSettings: Dispatch<SetStateAction<ChatSettings>>;
}

export const AppContext = createContext<AppState | null>(null);

export function useApp(): AppState {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error("useApp outside AppContext");
  return ctx;
}
