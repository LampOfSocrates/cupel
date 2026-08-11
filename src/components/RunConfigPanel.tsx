import { useState, type ReactNode } from "react";
import {
  Badge,
  Box,
  Group,
  NumberInput,
  Select,
  Stack,
  Switch,
} from "@mantine/core";
import type {
  Agent,
  JudgeConfig,
  Model,
  Rubric,
  Variant,
} from "../api/types";

// Evaluations step 2 — Variant drawer (feature-spec.md:46-48): "Agent tree +
// instruction version · Model, temperature · Judge (optional, collapsed by
// default): toggle on → judge model + rubric fields appear". Fields mirror
// Variant (openapi.yaml:1483-1506); the XOR rule (openapi.yaml:1488-1489
// "instruction_version XOR snapshot_id — a snapshot is an untested draft;
// neither = the live version") is enforced in UI state: choosing a version
// clears the snapshot and vice versa is impossible (snapshots arrive only via
// props/value from Test-as-evaluation).
//
// Diff-from-baseline (feature-spec.md:45 "prefilled from the baseline so
// changing one axis = one field"; e2e checklist :208 "version change
// highlighted"): fields whose value deviates from the `baseline` prop get a
// data-changed wrapper with a highlight border.
//
// Data flow: dropdown data (agents/versions/models/rubrics) is
// passed IN as props — the panel stays pure/fetch-free so it renders in tests
// and drawers alike; the page-level Configure step owns the fetches
// (feature-spec.md:226: "GET …/instructions, GET /models, GET /eval/rubrics").
//
// No endpoints multi-select here: varying the deploy endpoint "only applies to
// turn re-fire" (openapi.yaml:1490; feature-spec.md:67), and turn re-fire has
// its own picker in ForkModal.

interface Props {
  value: Variant;
  onChange: (next: Variant) => void;
  baseline?: Variant | null;
  agents?: Agent[];
  /** Instruction versions available for the selected agent. */
  versions?: number[];
  models?: Model[];
  rubrics?: Rubric[];
  /** Scope flag: false keeps the judge section dormant entirely. */
  showJudge?: boolean;
  /** Display label for value.snapshot_id, e.g. "v15-draft (a3f2)" (feature-spec.md:86). */
  snapshotLabel?: string;
}

// Highlight wrapper — presence of data-changed marks a deviation from baseline.
function Field({ changed, children }: { changed: boolean; children: ReactNode }) {
  return (
    <Box
      data-changed={changed || undefined}
      style={
        changed
          ? {
              borderLeft: "3px solid var(--mantine-color-yellow-5)",
              paddingLeft: 8,
              marginLeft: -11,
            }
          : undefined
      }
    >
      {children}
    </Box>
  );
}

export function RunConfigPanel({
  value,
  onChange,
  baseline,
  agents = [],
  versions = [],
  models = [],
  rubrics = [],
  showJudge = true,
  snapshotLabel,
}: Props) {
  // Judge draft: JudgeConfig requires BOTH judge_model and rubric_id
  // (openapi.yaml:1510) — while the user is mid-selection the draft lives
  // here and value.judge is only emitted once complete (or null on toggle off).
  // An open-but-empty section emits nothing until complete.
  const [judgeOpen, setJudgeOpen] = useState(value.judge != null);
  const [judgeDraft, setJudgeDraft] = useState<Partial<JudgeConfig>>(value.judge ?? {});

  const set = (patch: Partial<Variant>) => onChange({ ...value, ...patch });

  const changed = {
    agent: baseline != null && (value.agent_id ?? null) !== (baseline.agent_id ?? null),
    version:
      baseline != null &&
      ((value.instruction_version ?? null) !== (baseline.instruction_version ?? null) ||
        (value.snapshot_id ?? null) !== (baseline.snapshot_id ?? null)),
    model: baseline != null && (value.model ?? null) !== (baseline.model ?? null),
    temperature:
      baseline != null && (value.temperature ?? null) !== (baseline.temperature ?? null),
    judge:
      baseline != null &&
      JSON.stringify(value.judge ?? null) !== JSON.stringify(baseline.judge ?? null),
  };

  const updateJudge = (patch: Partial<JudgeConfig>) => {
    const draft = { ...judgeDraft, ...patch };
    setJudgeDraft(draft);
    if (draft.judge_model && draft.rubric_id) {
      set({ judge: { judge_model: draft.judge_model, rubric_id: draft.rubric_id } });
    }
  };

  const toggleJudge = (open: boolean) => {
    setJudgeOpen(open);
    if (!open) set({ judge: null });
    else if (judgeDraft.judge_model && judgeDraft.rubric_id) {
      set({ judge: { judge_model: judgeDraft.judge_model, rubric_id: judgeDraft.rubric_id } });
    }
  };

  return (
    <Stack gap="sm">
      <Field changed={changed.agent}>
        <Select
          size="xs"
          label="Agent"
          placeholder="Agent"
          data={agents.map((a) => ({ value: a.id, label: a.name }))}
          value={value.agent_id ?? null}
          onChange={(agent_id) => set({ agent_id })}
          clearable
        />
      </Field>
      <Field changed={changed.version}>
        <Select
          size="xs"
          label="Instruction version"
          // Neither version nor snapshot = the live version (openapi.yaml:1489).
          placeholder={value.snapshot_id ? "—" : "live"}
          data={versions.map((v) => ({ value: String(v), label: `v${v}` }))}
          value={value.instruction_version != null ? String(value.instruction_version) : null}
          // XOR: picking a version always clears any snapshot; clearing both = live.
          onChange={(v) =>
            set({
              instruction_version: v != null ? Number(v) : null,
              snapshot_id: null,
            })
          }
          clearable
        />
        {value.snapshot_id != null && (
          <Badge size="xs" variant="light" color="grape" mt={4} data-testid="snapshot-badge">
            {snapshotLabel ?? `snapshot ${value.snapshot_id}`}
          </Badge>
        )}
      </Field>
      <Field changed={changed.model}>
        <Select
          size="xs"
          label="Model"
          placeholder="Model"
          data={models.map((m) => ({ value: m.id, label: m.name }))}
          value={value.model ?? null}
          onChange={(model) => set({ model })}
          clearable
        />
      </Field>
      <Field changed={changed.temperature}>
        <NumberInput
          size="xs"
          label="Temperature"
          min={0}
          max={2}
          step={0.1}
          value={value.temperature ?? ""}
          onChange={(v) => set({ temperature: typeof v === "number" ? v : null })}
        />
      </Field>
      {showJudge && (
      <Field changed={changed.judge}>
        <Switch
          size="xs"
          label="⚖ Judge"
          checked={judgeOpen}
          onChange={(e) => toggleJudge(e.currentTarget.checked)}
        />
        {judgeOpen && (
          <Group grow mt={6}>
            <Select
              size="xs"
              label="Judge model"
              placeholder="Judge model"
              data={models.map((m) => ({ value: m.id, label: m.name }))}
              value={judgeDraft.judge_model ?? null}
              onChange={(judge_model) => updateJudge({ judge_model: judge_model ?? undefined })}
            />
            <Select
              size="xs"
              label="Rubric"
              placeholder="Rubric"
              data={rubrics.map((r) => ({ value: r.id, label: `${r.name} v${r.version}` }))}
              value={judgeDraft.rubric_id ?? null}
              onChange={(rubric_id) => updateJudge({ rubric_id: rubric_id ?? undefined })}
            />
          </Group>
        )}
      </Field>
      )}
    </Stack>
  );
}
