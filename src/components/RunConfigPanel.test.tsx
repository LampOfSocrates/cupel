import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MantineProvider } from "@mantine/core";
import { RunConfigPanel } from "./RunConfigPanel";
import type { Endpoint, Model, Rubric, RunConfig } from "../api/types";

// Contract under test: RunConfig (openapi.yaml:1483-1506) — "instruction_
// version XOR snapshot_id — a snapshot is an untested draft; neither = the
// live version"; JudgeConfig requires judge_model + rubric_id (:1508-1514,
// "Judge section, collapsed by default"). Diff-from-baseline: "prefilled from
// the baseline so changing one axis = one field" (feature-spec.md:45);
// "version change highlighted" (feature-spec.md:204).

const models: Model[] = [
  { id: "claude-sonnet-5", name: "Claude Sonnet 5" },
  { id: "claude-opus", name: "Claude Opus" },
];
const rubrics: Rubric[] = [
  { id: "rub-1", name: "helpfulness", version: 3, prompt: "…", created_at: "2026-08-01T00:00:00Z" },
];
const endpoints: Endpoint[] = [
  { id: "prod", name: "prod" },
  { id: "staging", name: "staging" },
];

function renderPanel(props: Partial<Parameters<typeof RunConfigPanel>[0]> = {}) {
  const onChange = vi.fn();
  render(
    <MantineProvider env="test">
      <RunConfigPanel
        value={props.value ?? {}}
        onChange={onChange}
        versions={[14, 15]}
        models={models}
        rubrics={rubrics}
        endpoints={endpoints}
        {...props}
      />
    </MantineProvider>,
  );
  return onChange;
}

describe("RunConfigPanel", () => {
  it("enforces the version/snapshot XOR: picking a version clears the snapshot", async () => {
    const user = userEvent.setup();
    const value: RunConfig = { snapshot_id: "snap-a3f2" };
    const onChange = renderPanel({ value, snapshotLabel: "v15-draft (a3f2)" });

    // snapshot displayed (feature-spec.md:86 'display as "v15-draft (a3f2)"')
    expect(screen.getByTestId("snapshot-badge")).toHaveTextContent("v15-draft (a3f2)");

    await user.click(screen.getByRole("combobox", { name: "Instruction version" }));
    await user.click(await screen.findByRole("option", { name: "v15" }));
    expect(onChange).toHaveBeenLastCalledWith({
      instruction_version: 15,
      snapshot_id: null,
    });
  });

  it("clearing the version leaves neither set = the live version", async () => {
    const user = userEvent.setup();
    const onChange = renderPanel({ value: { instruction_version: 14 } });
    await user.click(screen.getByRole("combobox", { name: "Instruction version" }));
    await user.click(await screen.findByRole("option", { name: "v14" })); // deselect
    expect(onChange).toHaveBeenLastCalledWith({
      instruction_version: null,
      snapshot_id: null,
    });
  });

  it("highlights only the fields that deviate from the baseline", () => {
    const baseline: RunConfig = { instruction_version: 14, model: "claude-sonnet-5", temperature: 0.7 };
    const value: RunConfig = { instruction_version: 15, model: "claude-sonnet-5", temperature: 0.7 };
    renderPanel({ value, baseline });

    const changed = document.querySelectorAll("[data-changed]");
    expect(changed).toHaveLength(1);
    expect(changed[0]).toContainElement(
      screen.getByRole("combobox", { name: "Instruction version" }),
    );
  });

  it("highlights nothing without a baseline", () => {
    renderPanel({ value: { instruction_version: 15, model: "claude-opus" } });
    expect(document.querySelectorAll("[data-changed]")).toHaveLength(0);
  });

  it("judge section is collapsed by default; toggling on reveals judge model + rubric", async () => {
    const user = userEvent.setup();
    const onChange = renderPanel({});
    expect(screen.queryByRole("combobox", { name: "Rubric" })).not.toBeInTheDocument();
    expect(screen.queryByRole("combobox", { name: "Judge model" })).not.toBeInTheDocument();

    await user.click(screen.getByRole("switch", { name: "⚖ Judge" }));
    expect(screen.getByRole("combobox", { name: "Rubric" })).toBeInTheDocument();
    // incomplete judge (model only) is NOT emitted — JudgeConfig requires both
    await user.click(screen.getByRole("combobox", { name: "Judge model" }));
    await user.click(await screen.findByRole("option", { name: "Claude Opus" }));
    expect(onChange).not.toHaveBeenCalled();

    await user.click(screen.getByRole("combobox", { name: "Rubric" }));
    await user.click(await screen.findByRole("option", { name: "helpfulness v3" }));
    expect(onChange).toHaveBeenLastCalledWith({
      judge: { judge_model: "claude-opus", rubric_id: "rub-1" },
    });
  });

  it("toggling judge off emits judge: null", async () => {
    const user = userEvent.setup();
    const value: RunConfig = { judge: { judge_model: "claude-opus", rubric_id: "rub-1" } };
    const onChange = renderPanel({ value });
    // pre-set judge opens the section
    expect(screen.getByRole("combobox", { name: "Rubric" })).toBeInTheDocument();
    await user.click(screen.getByRole("switch", { name: "⚖ Judge" }));
    expect(onChange).toHaveBeenLastCalledWith({ judge: null });
  });

  it("showJudge=false keeps the judge section fully dormant (P1-T11 scope guard)", () => {
    renderPanel({ showJudge: false });
    expect(screen.queryByRole("switch", { name: "⚖ Judge" })).not.toBeInTheDocument();
  });

  it("endpoints multi-select renders only when showEndpoints is set", () => {
    renderPanel({});
    expect(screen.queryByRole("combobox", { name: "Endpoints" })).not.toBeInTheDocument();
  });

  it("emits endpoint_ids from the multi-select when showEndpoints", async () => {
    const user = userEvent.setup();
    const onChange = renderPanel({ showEndpoints: true });
    await user.click(screen.getByRole("combobox", { name: "Endpoints" }));
    await user.click(await screen.findByRole("option", { name: "prod" }));
    expect(onChange).toHaveBeenLastCalledWith({ endpoint_ids: ["prod"] });
  });
});
