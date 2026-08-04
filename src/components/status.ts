// Shared status → Mantine color map. Tasks and runs use the same five-state
// enum (openapi.yaml:1602, :1739 "queued, running, done, failed, cancelled");
// cells use a four-state subset (openapi.yaml:1649).
export type LifecycleStatus = "queued" | "running" | "done" | "failed" | "cancelled";

export const STATUS_COLOR: Record<LifecycleStatus, string> = {
  queued: "gray",
  running: "blue",
  done: "teal",
  failed: "red",
  cancelled: "orange",
};
