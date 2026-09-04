import { useState } from "react";
import { Anchor, Badge, Box, Group, ScrollArea, Text, Textarea, UnstyledButton } from "@mantine/core";
import { api } from "../../api/client";
import type { Agent, InstructionHistory } from "../../api/types";
import { useAsync } from "../../hooks/useAsync";

// "Agent instructions for this run" — step 2's most important control.
//
// PER-RUN DRAFTS. Editing here changes what THIS run executes and nothing
// else: the live instruction version is untouched and stays live. The contract
// already has the mechanism — a SNAPSHOT is "an untested draft"
// (openapi.yaml Variant: "instruction_version XOR snapshot_id — a snapshot is
// an untested draft; neither = the live version") — so an edit becomes
// POST …/agents/{id}/snapshots at queue time and the run carries its id.
// Nothing here writes an instruction version; publishing one is a separate,
// explicit action in the editor.
//
// The draft is held in React state until then rather than snapshotted per
// keystroke: snapshots are immutable and append-only, so a snapshot per
// keystroke would be a permanent record of every backspace.
//
// ONE AGENT PER RUN, and that is the contract talking, not a simplification:
// Variant carries a single agent_id + snapshot_id (openapi.yaml:3262-3275), so
// a run can override exactly one agent's instructions. The list below lets you
// pick WHICH; editing a second agent moves the override rather than adding one,
// and the UI says so instead of quietly sending a request that means something
// narrower than the screen implies.

export interface RunDraft {
  agentId: string;
  content: string;
}

interface Props {
  tree: string;
  agents: Agent[];
  /** The single per-run instruction override, or null for "live everywhere". */
  draft: RunDraft | null;
  onDraftChange: (draft: RunDraft | null) => void;
}

function liveContent(history: InstructionHistory | undefined): string {
  if (!history) return "";
  return history.versions.find((v) => v.version === history.live_version)?.content ?? "";
}

export function InstructionsForRun({ tree, agents, draft, onDraftChange }: Props) {
  const [activeId, setActiveId] = useState<string | null>(agents[0]?.id ?? null);
  const active = agents.find((a) => a.id === activeId) ?? agents[0] ?? null;

  const history = useAsync<InstructionHistory | null>(
    active ? () => api.instructions(tree, active.id) : null,
    [tree, active?.id],
  );

  if (!active) {
    return (
      <Text fz="sm" c="gray.6" p="sm">
        This {tree} has no agents to instruct.
      </Text>
    );
  }

  const live = liveContent(history.data ?? undefined);
  const editedHere = draft?.agentId === active.id;
  const value = editedHere ? draft.content : live;

  return (
    <Box>
      <Text fz="lg" fw={600}>
        Agent instructions for this run
      </Text>
      <Text fz="sm" c="gray.6" mb={6}>
        {draft
          ? `${agents.find((a) => a.id === draft.agentId)?.name ?? draft.agentId} is edited for this run — saved as a draft version, the live one stays untouched.`
          : "Editing here only affects this run. Save to the tree afterwards if it works."}
      </Text>

      <Group
        gap={0}
        align="stretch"
        wrap="nowrap"
        style={{ border: "1px solid var(--mantine-color-gray-4)", borderRadius: 8 }}
      >
        <Box
          style={{
            flex: "0 1 210px",
            minWidth: 150,
            borderRight: "1px solid var(--mantine-color-gray-3)",
          }}
        >
          <Text fz="xs" c="gray.6" px={10} py={6} style={{ letterSpacing: "0.05em" }}>
            {tree.toUpperCase()} · {agents.length} AGENT{agents.length === 1 ? "" : "S"}
          </Text>
          <ScrollArea.Autosize mah={260}>
            {agents.map((agent) => {
              const isActive = agent.id === active.id;
              const isEdited = draft?.agentId === agent.id;
              return (
                <UnstyledButton
                  key={agent.id}
                  onClick={() => setActiveId(agent.id)}
                  data-active={isActive || undefined}
                  style={{
                    display: "block",
                    width: "100%",
                    padding: "5px 10px",
                    background: isActive ? "var(--mantine-color-accent-0)" : undefined,
                    borderLeft: `2px solid ${isActive ? "var(--mantine-color-accent-6)" : "transparent"}`,
                  }}
                >
                  <Group gap={6} wrap="nowrap" justify="space-between">
                    <Box style={{ minWidth: 0 }}>
                      <Text fz="sm" fw={500} truncate>
                        {agent.name}
                      </Text>
                      <Text ff="monospace" fz="xs" c="gray.5">
                        {/* The version label carries the whole state: live, or
                            live-plus-a-draft-for-this-run. */}
                        v{agent.live_version}
                        {isEdited ? " → draft" : " (live)"}
                      </Text>
                    </Box>
                    {isEdited && (
                      <Box
                        w={6}
                        h={6}
                        style={{ borderRadius: "50%", background: "var(--mantine-color-accent-6)" }}
                      />
                    )}
                  </Group>
                </UnstyledButton>
              );
            })}
          </ScrollArea.Autosize>
        </Box>

        <Box style={{ flex: 1, minWidth: 0 }}>
          <Group px={10} py={6} gap={8} wrap="nowrap" justify="space-between">
            <Group gap={8} wrap="nowrap" style={{ minWidth: 0 }}>
              <Text fz="md" fw={600} truncate>
                {active.name}
              </Text>
              {editedHere && (
                <Badge size="xs" radius="lg" variant="light" color="accent">
                  edited for this run
                </Badge>
              )}
              {editedHere && (
                <Anchor
                  component="button"
                  type="button"
                  fz="xs"
                  onClick={() => onDraftChange(null)}
                >
                  reset to v{active.live_version}
                </Anchor>
              )}
            </Group>
            <Text ff="monospace" fz="xs" c="gray.5">
              v{active.live_version}
            </Text>
          </Group>

          {/* Editing a DIFFERENT agent while one is already drafted would move
              the override, not add one — Variant holds a single agent_id. Said
              plainly rather than discovered when the run comes back narrower
              than the screen implied. */}
          {draft && !editedHere && (
            <Text fz="xs" c="warning.7" bg="warning.0" px={10} py={4}>
              A run carries one instruction override. Editing {active.name} will move it off{" "}
              {agents.find((a) => a.id === draft.agentId)?.name ?? draft.agentId}.
            </Text>
          )}

          <Textarea
            value={history.loading ? "" : value}
            placeholder={history.loading ? "Loading…" : undefined}
            spellCheck={false}
            autosize
            minRows={8}
            maxRows={16}
            aria-label={`Instructions for ${active.name}`}
            onChange={(event) => {
              const next = event.currentTarget.value;
              // Back to exactly the live text = no override at all, rather
              // than a snapshot identical to what is already live.
              onDraftChange(next === live ? null : { agentId: active.id, content: next });
            }}
            styles={{
              input: {
                border: "none",
                borderRadius: 0,
                fontFamily: "var(--mantine-font-family-monospace)",
                fontSize: "0.6875rem",
                lineHeight: 1.75,
                padding: 12,
                resize: "none",
              },
            }}
          />
        </Box>
      </Group>
    </Box>
  );
}
