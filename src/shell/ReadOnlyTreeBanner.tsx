import { Alert } from "@mantine/core";
import { useApp } from "../AppContext";

// Read-only banner — "existing conversations stay READABLE (read-only
// banner) so history and traces aren't lost" (feature-spec.md:20;
// openapi.yaml:288-291). Rendered by the pages that CREATE work (Chat, Runs):
// every write there answers 409 tree_disabled, so the banner explains the
// state before the user hits the error.
//
// Reaching this state at all means the caller is an admin — "GET /agenttrees
// (permitted + enabled; admins also see disabled)" (feature-spec.md:121)
// filters a disabled tree out of a non-admin's listing entirely, so it never
// becomes their active tree. Nothing here reads a role or an auth mode: the
// banner is driven purely by the tree's `enabled` flag from the boot fetch.
export function ReadOnlyTreeBanner() {
  const { trees, tree } = useApp();
  const active = trees.find((t) => t.id === tree);
  if (!active || active.enabled) return null;
  return (
    <Alert color="yellow" py={6} data-testid="read-only-banner">
      {active.name} is disabled — history is read-only. New chats and evaluations
      are blocked until it is re-enabled in Settings.
    </Alert>
  );
}
