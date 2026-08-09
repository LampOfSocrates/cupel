import { Alert, Divider, Drawer, Group, Loader, Stack, Text } from "@mantine/core";
import { api } from "../api/client";
import { useAsync } from "../hooks/useAsync";
import type { Judgment, Rubric } from "../api/types";
import { EnvelopeChip } from "./EnvelopeChip";
import { ScoreChip } from "./ScoreChip";

// Judgment drawer. UNSKETCHED (cupel-phases.md:22 "judgment drawer
// (unsketched)") — layout derived from the app's Mantine language, kept dense.
// Contents per feature-spec.md:64: "Tap a badge → judgment drawer: score,
// judge reasoning, rubric+version, judge model, input/output/reference side by
// side, and append-only history below", wired to the drawer's endpoints
// (feature-spec.md:229): "GET /eval/judgments?subject_kind=case&subject_id=,
// GET /eval/cases/{id}".
//
// History is APPEND-ONLY and rendered as such — feature-spec.md:59: "Judgment
// (persisted forever, never overwritten) … Re-judging appends a new judgment;
// history per case is queryable, so scores are comparable across
// time/judges/rubrics". Entries arrive newest first (openapi.yaml:994) and
// every one stays visible.

interface Props {
  caseId: string;
  opened: boolean;
  onClose: () => void;
  /** For rubric-name labels; ids render as-is when the list lacks a match. */
  rubrics?: Rubric[];
}

export function JudgmentDrawer({ caseId, opened, onClose, rubrics = [] }: Props) {
  const { data, error } = useAsync(
    () =>
      Promise.all([
        api.evalCase(caseId),
        api.judgments({ subject_kind: "case", subject_id: caseId }),
      ]),
    [caseId],
  );
  const evalCase = data?.[0] ?? null;
  const history = data?.[1] ?? null;

  // The scorer names itself: kind human = a thumb, which runs no rubric and
  // no model (openapi.yaml Scorer), so there is nothing further to label.
  const judgeLabel = ({ scorer }: Judgment) => {
    if (scorer.kind === "human") return "human 👍/👎";
    const name = rubrics.find((r) => r.id === scorer.ref)?.name ?? scorer.ref;
    return `${scorer.model} · ${name} v${scorer.version}`;
  };

  return (
    <Drawer
      opened={opened}
      onClose={onClose}
      position="right"
      size="md"
      title={`Case ${caseId}`}
    >
      {error && (
        <Alert color="red" title="Error">
          {error.message}
        </Alert>
      )}
      {!error && (evalCase == null || history == null) && <Loader size="sm" />}
      {evalCase != null && history != null && (
        <Stack gap="sm">
          {/* EvalCase = {input, output, reference?}; input = prompt + frozen
              envelope (feature-spec.md:54-57; openapi.yaml:1834-1844). */}
          <div>
            <Text size="xs" c="dimmed" fw={600}>
              Input
            </Text>
            <Text size="sm">{evalCase.input.prompt}</Text>
            <EnvelopeChip envelope={evalCase.input.envelope ?? null} />
          </div>
          <div>
            <Text size="xs" c="dimmed" fw={600}>
              Output
            </Text>
            <Text size="sm">{evalCase.output}</Text>
          </div>
          {evalCase.reference != null && (
            <div>
              <Text size="xs" c="dimmed" fw={600}>
                Reference
              </Text>
              <Text size="sm">{evalCase.reference}</Text>
            </div>
          )}
          <Divider />
          <Text size="xs" c="dimmed" fw={600} data-testid="judgment-history-heading">
            History ({history.length}) — append-only, every past score kept
          </Text>
          {history.length === 0 && (
            <Text size="xs" c="dimmed">
              No judgments yet.
            </Text>
          )}
          {history.map((j) => (
            <Group key={j.id} gap={8} align="flex-start" wrap="nowrap" data-testid="judgment-entry">
              <ScoreChip score={j.score} />
              <div>
                <Text size="xs" c="dimmed">
                  {judgeLabel(j)} · {j.created_at}
                </Text>
                {j.reasoning != null && <Text size="xs">{j.reasoning}</Text>}
              </div>
            </Group>
          ))}
        </Stack>
      )}
    </Drawer>
  );
}
