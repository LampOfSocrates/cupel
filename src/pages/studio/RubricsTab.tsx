import { useState } from "react";
import {
  Badge,
  Button,
  Divider,
  Group,
  Loader,
  Paper,
  Stack,
  Text,
  Textarea,
  TextInput,
  UnstyledButton,
} from "@mantine/core";
import { api } from "../../api/client";
import { useStudio, useStudioState } from "./StudioContext";

// Rubric editor — "rubric editor (prompt text, save = new version…)"
// (feature-spec.md:63). The prompt buffer lives in the Studio frame
// (useStudioState) because a half-written scoring prompt is the most expensive
// thing on this screen to lose, and the tabs are routes that unmount.
export function RubricsTab() {
  const { rubrics, rubricsTotal: total, reloadRubrics, loadMoreRubrics, setError } = useStudio();

  const [selectedId, setSelectedId] = useStudioState<string | null>("rubrics.selectedId", null);
  const [prompt, setPrompt] = useStudioState("rubrics.prompt", "");
  const [newName, setNewName] = useStudioState("rubrics.newName", "");
  const [notice, setNotice] = useStudioState<string | null>("rubrics.notice", null);
  const [busy, setBusy] = useState(false);

  const selected = rubrics?.find((r) => r.id === selectedId) ?? null;

  async function saveVersion() {
    if (!selected) return;
    setBusy(true);
    try {
      // "save = new version" (feature-spec.md:128; openapi.yaml:1317-1319).
      const saved = await api.createRubricVersion(selected.id, { prompt });
      setNotice(`Saved as version ${saved.version}.`);
      await reloadRubrics();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }

  async function createRubric() {
    setBusy(true);
    try {
      const created = await api.createRubric({ name: newName, prompt });
      setNewName("");
      setSelectedId(created.id);
      setNotice(`Created ${created.name} v${created.version}.`);
      await reloadRubrics();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Group align="flex-start" gap="sm" wrap="nowrap">
      <Paper withBorder p="xs" w={300} style={{ flexShrink: 0 }}>
        <Stack gap={6}>
          {rubrics === null && <Loader size="xs" />}
          {rubrics?.length === 0 && (
            <Text size="xs" c="dimmed" data-testid="rubrics-empty">
              No rubrics yet. A rubric is the scoring prompt the judge runs; saving one always
              creates a new version so old scores stay comparable.
            </Text>
          )}
          <Stack gap={2}>
            {(rubrics ?? []).map((r) => (
              <UnstyledButton
                key={r.id}
                data-testid={`rubric-row-${r.id}`}
                onClick={() => {
                  setSelectedId(r.id);
                  setPrompt(r.prompt);
                  setNotice(null);
                }}
                style={{ width: "100%" }}
              >
                <Group gap={6} px={4} py={3}>
                  <Text size="xs" truncate style={{ flex: 1 }}>
                    {r.name}
                  </Text>
                  <Badge size="xs" variant="light">
                    v{r.version}
                  </Badge>
                </Group>
              </UnstyledButton>
            ))}
            {rubrics != null && total > rubrics.length && (
              <Button
                variant="subtle"
                size="compact-xs"
                data-testid="rubrics-load-more"
                onClick={() => void loadMoreRubrics()}
              >
                Load more ({rubrics.length} of {total})
              </Button>
            )}
          </Stack>
          <Divider my={2} />
          <TextInput
            size="xs"
            label="New rubric name"
            value={newName}
            onChange={(e) => setNewName(e.currentTarget.value)}
          />
          <Button
            size="compact-xs"
            variant="light"
            onClick={createRubric}
            loading={busy}
            disabled={!newName.trim() || !prompt.trim()}
          >
            Create rubric
          </Button>
        </Stack>
      </Paper>
      <Paper withBorder p="xs" style={{ flex: 1 }}>
        <Stack gap={6}>
          <Group gap={6}>
            <Text fw={600} size="sm">
              {selected ? selected.name : "Rubric prompt"}
            </Text>
            {selected && (
              <Badge size="xs" variant="light">
                v{selected.version}
              </Badge>
            )}
          </Group>
          <Textarea
            size="xs"
            aria-label="Rubric prompt"
            autosize
            minRows={6}
            value={prompt}
            onChange={(e) => setPrompt(e.currentTarget.value)}
          />
          <Group>
            <Button
              size="xs"
              onClick={saveVersion}
              loading={busy}
              disabled={!selected || !prompt.trim()}
            >
              Save as new version
            </Button>
            {notice && (
              <Text size="xs" c="dimmed" data-testid="rubric-notice">
                {notice}
              </Text>
            )}
          </Group>
        </Stack>
      </Paper>
    </Group>
  );
}
