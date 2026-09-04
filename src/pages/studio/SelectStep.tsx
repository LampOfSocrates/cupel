import { useState } from "react";
import { Box, Text, UnstyledButton } from "@mantine/core";
import { api } from "../../api/client";
import type { Conversation, SelectionItem } from "../../api/types";
import { ConversationPicker } from "../../components";
import { useAsync } from "../../hooks/useAsync";
import { SelectedPanel } from "./SelectedPanel";

// Step 1 of the evaluation wizard: the browse grid and the Selected panel,
// and the split that INVERTS between them as you make progress.
//
// Before anything is picked the grid has the room and the Selected panel is a
// 340px sidebar explaining itself. The moment something IS picked the grid
// collapses to a 46px vertical ribbon and the panel takes the width — because
// from then on the interesting question is not "what else is there" but "is
// this the right set". The ribbon is always one click from reopening, and
// Clear all reopens it for you: it is a stage that shrank, not a door that
// locked.
//
// The collapse is DERIVED, never stored: collapsed = something is picked AND
// nobody has asked for the grid back. So the first pick collapses it, a later
// "Keep picking" keeps it open through subsequent picks, and Clear all — which
// empties the selection — gives it back for free. Writing the collapse into
// state from an effect would be the same rule, one render late, with two
// sources of truth for it.

const RIBBON_WIDTH = 46;
const PANEL_WIDTH = 340;

function CollapsedRibbon({ total, onClick }: { total: number; onClick: () => void }) {
  return (
    <UnstyledButton
      onClick={onClick}
      data-testid="browse-ribbon"
      aria-label="Browse conversations"
      style={{
        flex: `0 0 ${RIBBON_WIDTH}px`,
        background: "var(--mantine-color-gray-1)",
        borderRight: "1px solid var(--mantine-color-gray-4)",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        gap: 8,
        paddingTop: 10,
      }}
    >
      <Text fz="xs" c="gray.6">
        ▸
      </Text>
      <Text
        fz="xs"
        c="gray.6"
        style={{ writingMode: "vertical-rl", whiteSpace: "nowrap" }}
      >
        Browse all {total.toLocaleString()} conversations
      </Text>
    </UnstyledButton>
  );
}

export function SelectStep({
  tree,
  selection,
  onSelectionChange,
}: {
  tree: string;
  selection: SelectionItem[];
  onSelectionChange: (items: SelectionItem[]) => void;
}) {
  // "Has someone asked for the grid back?" — not "is the grid open".
  const [browseAsked, setBrowseAsked] = useState(false);

  // The Selected panel names what you picked, and a pick can outlive the page
  // that listed it (a remembered last-selection arrives before any listing).
  // So the titles come from their own read rather than from whatever the grid
  // happens to have paged in.
  const listing = useAsync<{ items: Conversation[]; total: number }>(
    () => api.conversations(tree, { page_size: 100 }),
    [tree],
  );
  const known = listing.data?.items ?? [];
  const total = listing.data?.total ?? 0;

  const collapsed = selection.length > 0 && !browseAsked;

  return (
    <Box style={{ display: "flex", minHeight: 0, flex: 1, gap: 0 }} data-testid="select-step">
      {collapsed ? (
        <CollapsedRibbon total={total} onClick={() => setBrowseAsked(true)} />
      ) : (
        <Box style={{ flex: 1, minWidth: 0, overflow: "auto" }}>
          <ConversationPicker
            tree={tree}
            selection={selection}
            onSelectionChange={onSelectionChange}
          />
        </Box>
      )}

      <Box
        style={{
          flex: collapsed ? 1 : `0 0 ${PANEL_WIDTH}px`,
          minWidth: 0,
          borderLeft: "1px solid var(--mantine-color-gray-4)",
          display: "flex",
          flexDirection: "column",
          minHeight: 0,
        }}
      >
        <SelectedPanel
          tree={tree}
          selection={selection}
          known={known}
          onSelectionChange={(items) => {
            // Clear all reopens the grid: an empty panel with a collapsed grid
            // would be a screen with nothing on it and no obvious way back.
            if (items.length === 0) setBrowseAsked(false);
            onSelectionChange(items);
          }}
          onKeepPicking={collapsed ? () => setBrowseAsked(true) : undefined}
        />
      </Box>
    </Box>
  );
}
