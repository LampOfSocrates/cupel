import { createContext, useContext } from "react";
import type { AgentTree, Me, Model } from "./api/types";

export interface AppState {
  me: Me;
  trees: AgentTree[];
  tree: string; // current tree id — defaults to agent1
  // Switches the active tree, device-locally persisted (src/App.tsx). A
  // no-op if `id` doesn't name an ENABLED tree in `trees` — the switcher UI
  // (Sidebar) already disables that option, this is the defense-in-depth
  // backstop against a stale id (e.g. a disabled tree re-enabled elsewhere).
  setTree: (id: string) => void;
  // Sidebar refresh signal: chat sends that create/update conversations bump
  // the version so ConversationList reloads (feature-spec.md:5 recent list).
  conversationsVersion: number;
  refreshConversations: () => void;
  // GET /models result, fetched once on first use and cached for the session
  // (feature-spec.md:118 "chat/run/judge model dropdowns" — Evaluations reuses it).
  models: Model[] | null;
  ensureModels: () => void;
}

export const AppContext = createContext<AppState | null>(null);

export function useApp(): AppState {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error("useApp outside AppContext");
  return ctx;
}
