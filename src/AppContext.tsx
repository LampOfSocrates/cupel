import { createContext, useContext } from "react";
import type { AgentTree, Me } from "./api/types";

export interface AppState {
  me: Me;
  trees: AgentTree[];
  tree: string; // current tree id — defaults to agent1
}

export const AppContext = createContext<AppState | null>(null);

export function useApp(): AppState {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error("useApp outside AppContext");
  return ctx;
}
