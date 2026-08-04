import { createContext, useContext } from "react";
import type { AgentTree, Me } from "./api/types";

export interface AppState {
  me: Me;
  trees: AgentTree[];
  tree: string; // current tree id — defaults to agent1
  // Sidebar refresh signal: chat sends that create/update conversations bump
  // the version so ConversationList reloads (feature-spec.md:5 recent list).
  conversationsVersion: number;
  refreshConversations: () => void;
}

export const AppContext = createContext<AppState | null>(null);

export function useApp(): AppState {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error("useApp outside AppContext");
  return ctx;
}
