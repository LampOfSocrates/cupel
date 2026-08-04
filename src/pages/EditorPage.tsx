import { useParams } from "react-router";
import { Stack, Text, Title } from "@mantine/core";

// Placeholder — the instruction editor (versions/diff/snapshots, sketch 06)
// is P1-T10b. The tree view's node click / "Edit instructions" already routes
// here (feature-spec.md:26 "Node click → instruction editor").
export function EditorPage() {
  const { agentId } = useParams();
  return (
    <Stack gap={4}>
      <Title order={3}>Instruction editor — {agentId}</Title>
      <Text size="sm" c="dimmed">
        Coming in P1-T10b.
      </Text>
    </Stack>
  );
}
