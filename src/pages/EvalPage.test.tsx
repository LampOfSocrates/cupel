import { describe, expect, it } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Route, Routes } from "react-router";
import { renderApp } from "../test/render";
import {
  evalCaseCreates,
  evalCaseVersionPosts,
  evalSetCreates,
  evalSetDeletes,
  evalSetFreezes,
  evalSetVersionPosts,
  evalSetReplays,
  importConfig,
  importRequests,
  judgeRequests,
  mockEvalSets,
  mockRubrics,
  rubricVersionPosts,
} from "../test/msw/handlers";
import { EvalPage } from "./EvalPage";

// Contract under test — eval workbench (sketch 10; feature-spec.md:63
// "case editor (input / output / reference fields; 'reference from turn'
// picker), set manager (create/name/version sets, drag cases in), rubric
// editor (prompt text, save = new version…)"):
// - POST /eval/cases (openapi.yaml:1340-1369) handcrafted + sourced
// - POST /eval/cases/{caseId}/versions "save = NEW version"
// - GET/POST /eval/sets, POST /eval/sets/{setId}/versions "each save is a new
//   version carrying its FULL item list", DELETE, POST …/items, …/freeze,
//   …/replay — the merged noun, so this tab is also where collected turns land
// - POST /eval/rubrics/{rubricId}/versions "save = new version"
// - POST /eval/cases/import (:1370-1429) mapping + per-row report, 200 and 202
// - POST /eval/judge with set_id (:2926-2936)
//
// Cases are GLOBAL (feature-spec.md:111) — no tree in any of these paths.

function renderEval() {
  return renderApp(
    <Routes>
      <Route path="/eval" element={<EvalPage />} />
    </Routes>,
    // queue: the import modal reads the 202 task's report off the app-wide
    // queue store (openapi.yaml:2795-2802), so the provider must be present.
    { route: "/eval", queue: true },
  );
}

async function openTab(name: string) {
  await userEvent.click(screen.getByRole("tab", { name }));
}

// Textareas are set in one shot rather than typed character by character:
// these are multi-line prompt/answer fields and per-keystroke typing makes the
// suite slow enough to time out under parallel load.
function setField(label: string, value: string) {
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
}

describe("cases tab", () => {
  it("explains itself when nothing has been created in this session", async () => {
    renderEval();
    const empty = await screen.findByTestId("cases-empty");
    expect(empty.textContent).toMatch(/pull one from a real conversation turn/i);
    expect(screen.getByRole("button", { name: "+ New case" })).toBeInTheDocument();
  });

  it("creates a handcrafted case with input, output and reference", async () => {
    renderEval();
    await screen.findByTestId("cases-empty");

    setField("Input (prompt)", "Why was I charged twice?");
    setField("Output (candidate response)", "A temporary hold.");
    setField("Reference (expected answer)", "One charge; the hold drops in 3 days.");
    await userEvent.click(screen.getByRole("button", { name: "Create case" }));

    await waitFor(() => expect(evalCaseCreates).toHaveLength(1));
    expect(evalCaseCreates[0]).toEqual({
      input: { prompt: "Why was I charged twice?" },
      output: "A temporary hold.",
      reference: "One charge; the hold drops in 3 days.",
    });
    expect(await screen.findByTestId("case-notice")).toHaveTextContent("version 1");
  });

  it("sends a null reference when the field is left blank (reference-free rubrics)", async () => {
    renderEval();
    await screen.findByTestId("cases-empty");
    setField("Input (prompt)", "p");
    setField("Output (candidate response)", "o");
    await userEvent.click(screen.getByRole("button", { name: "Create case" }));
    await waitFor(() => expect(evalCaseCreates).toHaveLength(1));
    expect(evalCaseCreates[0]).toMatchObject({ reference: null });
  });

  it("editing an existing case PUTs the full content as a NEW version", async () => {
    renderEval();
    await screen.findByTestId("cases-empty");
    setField("Input (prompt)", "p");
    setField("Output (candidate response)", "o");
    await userEvent.click(screen.getByRole("button", { name: "Create case" }));
    const saveAgain = await screen.findByRole("button", { name: "Save as new version" });

    setField("Output (candidate response)", "o2");
    await userEvent.click(saveAgain);

    await waitFor(() => expect(evalCaseVersionPosts).toHaveLength(1));
    expect(evalCaseVersionPosts[0].caseId).toBe("case-new-1");
    expect(evalCaseVersionPosts[0].body).toEqual({
      input: { prompt: "p" },
      output: "o2",
      reference: null,
    });
    expect(await screen.findByTestId("case-notice")).toHaveTextContent("version 2");
  });

  it("states honestly that only the latest version is retrievable", async () => {
    renderEval();
    await screen.findByTestId("cases-empty");
    setField("Input (prompt)", "p");
    setField("Output (candidate response)", "o");
    await userEvent.click(screen.getByRole("button", { name: "Create case" }));
    const note = await screen.findByTestId("version-note");
    expect(note.textContent).toMatch(/latest version only/i);
    expect(note.textContent).toMatch(/not retrievable/i);
  });

  it("seeds a case from a real conversation turn (sourced creation)", async () => {
    renderEval();
    await screen.findByTestId("cases-empty");
    await userEvent.click(screen.getByRole("button", { name: "From turn" }));

    const dialog = await screen.findByRole("dialog");
    await userEvent.click(await within(dialog).findByText("Refund escalation"));
    const use = await within(dialog).findAllByRole("button", { name: "Use" });
    await userEvent.click(use[0]);

    await waitFor(() => expect(evalCaseCreates).toHaveLength(1));
    expect(evalCaseCreates[0]).toEqual({
      source: { tree: "agent1", conversation_id: "c1", turn_id: "t2" },
    });
  });

  it("pastes a turn's response into the reference field without creating a case", async () => {
    renderEval();
    await screen.findByTestId("cases-empty");
    await userEvent.click(screen.getByRole("button", { name: "Reference from turn" }));

    const dialog = await screen.findByRole("dialog");
    await userEvent.click(await within(dialog).findByText("Refund escalation"));
    const use = await within(dialog).findAllByRole("button", { name: "Use" });
    await userEvent.click(use[0]);

    await waitFor(() =>
      expect(screen.getByLabelText("Reference (expected answer)")).toHaveValue(
        "Approved refunds land in 3-5 days.",
      ),
    );
    expect(evalCaseCreates).toHaveLength(0);
  });

  it("judges a single case by case_ids", async () => {
    renderEval();
    await screen.findByTestId("cases-empty");
    setField("Input (prompt)", "p");
    setField("Output (candidate response)", "o");
    await userEvent.click(screen.getByRole("button", { name: "Create case" }));
    await screen.findByRole("button", { name: "Save as new version" });

    await userEvent.click(screen.getByRole("combobox", { name: "Judge model" }));
    await userEvent.click(await screen.findByRole("option", { name: "Claude Sonnet 5" }));
    await userEvent.click(screen.getByRole("button", { name: "Judge case" }));

    await waitFor(() => expect(judgeRequests).toHaveLength(1));
    expect(judgeRequests[0]).toEqual({
      case_ids: ["case-new-1"],
      rubric_id: "rub-help",
      judge_model: "claude-sonnet-5",
    });
  });
});

describe("sets tab", () => {
  it("creates a set and lists existing ones with their version", async () => {
    renderEval();
    await openTab("Sets");
    expect(await screen.findByTestId("set-row-set-refunds")).toHaveTextContent("v3");

    await userEvent.type(screen.getByLabelText("New set"), "regressions");
    await userEvent.click(screen.getByRole("button", { name: "Create set" }));

    await waitFor(() => expect(evalSetCreates).toHaveLength(1));
    expect(evalSetCreates[0]).toEqual({ name: "regressions" });
  });

  it("membership changes PUT the FULL item list as a new version", async () => {
    renderEval();
    await openTab("Sets");
    await userEvent.click(await screen.findByTestId("set-row-set-refunds"));

    // case-1 is already a frozen member (seeded set) — removing it sends the
    // remaining membership, not a delta.
    await userEvent.click(await screen.findByTestId("toggle-esi-1"));
    await userEvent.click(screen.getByRole("button", { name: "Save membership as new version" }));

    await waitFor(() => expect(evalSetVersionPosts).toHaveLength(1));
    expect(evalSetVersionPosts[0]).toEqual({ setId: "set-refunds", body: { items: [] } });
    expect(await screen.findByTestId("set-notice")).toHaveTextContent("version 4");
  });

  it("holds turn references and frozen cases in one list, and freezes in place", async () => {
    // The merge, on screen: what used to be a casebook is a set whose members
    // are references until you freeze them.
    renderEval();
    await openTab("Sets");
    await userEvent.click(await screen.findByTestId("set-row-set-misses"));
    expect(await screen.findByTestId("set-item")).toHaveTextContent("hedged answer");
    expect(screen.getByTestId("set-item")).toHaveTextContent("agent1");

    await userEvent.click(screen.getByRole("button", { name: /Freeze 1 reference/ }));
    await waitFor(() => expect(evalSetFreezes).toHaveLength(1));
    expect(evalSetFreezes[0]).toEqual({ setId: "set-misses", body: {} });
    // Versioned membership surfaced: the freeze appended v3.
    expect(await screen.findByTestId("set-notice")).toHaveTextContent("version 3");
    await waitFor(() =>
      expect(screen.getByTestId("set-item")).toHaveTextContent("frozen case"),
    );
  });

  it("replays the referenced turns and links each evaluation", async () => {
    renderEval();
    await openTab("Sets");
    await userEvent.click(await screen.findByTestId("set-row-set-misses"));
    await userEvent.click(screen.getByRole("button", { name: "Replay" }));

    await waitFor(() => expect(evalSetReplays).toHaveLength(1));
    expect(evalSetReplays[0]).toEqual({
      setId: "set-misses",
      body: { configs: [{}], context_policy: "frozen" },
    });
    const accepted = await screen.findByTestId("set-replay-accepted");
    expect(accepted).toHaveTextContent("agent1");
  });

  it("deleting a set removes it from the list", async () => {
    renderEval();
    await openTab("Sets");
    await userEvent.click(await screen.findByTestId("set-row-set-misses"));
    await userEvent.click(screen.getByRole("button", { name: "Delete set" }));
    await waitFor(() => expect(evalSetDeletes).toEqual(["set-misses"]));
    await waitFor(() =>
      expect(screen.queryByTestId("set-row-set-misses")).not.toBeInTheDocument(),
    );
  });

  it("judges a whole set, pinning the membership version on screen", async () => {
    renderEval();
    await openTab("Sets");
    await userEvent.click(await screen.findByTestId("set-row-set-refunds"));

    await userEvent.click(screen.getByRole("combobox", { name: "Judge model" }));
    await userEvent.click(await screen.findByRole("option", { name: "Claude Haiku 4.5" }));
    await userEvent.click(screen.getByRole("button", { name: "Judge set" }));

    await waitFor(() => expect(judgeRequests).toHaveLength(1));
    expect(judgeRequests[0]).toEqual({
      set_id: "set-refunds",
      set_version: 3,
      rubric_id: "rub-help",
      judge_model: "claude-haiku-4-5",
    });
    expect(await screen.findByTestId("set-notice")).toHaveTextContent("task-judge-1");
  });

  it("explains the screen when there are no sets", async () => {
    mockEvalSets.length = 0;
    renderEval();
    await openTab("Sets");
    expect(await screen.findByTestId("sets-empty")).toHaveTextContent(/named, versioned collection/i);
  });
});

describe("rubrics tab", () => {
  it("saving a rubric PUTs a new version", async () => {
    renderEval();
    await openTab("Rubrics");
    await userEvent.click(await screen.findByTestId("rubric-row-rub-help"));

    const prompt = screen.getByLabelText("Rubric prompt");
    await userEvent.clear(prompt);
    await userEvent.type(prompt, "Stricter wording.");
    await userEvent.click(screen.getByRole("button", { name: "Save as new version" }));

    await waitFor(() => expect(rubricVersionPosts).toHaveLength(1));
    expect(rubricVersionPosts[0]).toEqual({
      rubricId: "rub-help",
      body: { prompt: "Stricter wording." },
    });
    expect(await screen.findByTestId("rubric-notice")).toHaveTextContent("version 3");
  });

  it("explains the screen when there are no rubrics", async () => {
    mockRubrics.length = 0;
    renderEval();
    await openTab("Rubrics");
    expect(await screen.findByTestId("rubrics-empty")).toHaveTextContent(/scoring prompt/i);
  });
});

describe("import", () => {
  function csvFile(text: string, name = "cases.csv") {
    return new File([text], name, { type: "text/csv" });
  }

  // Mantine's FileInput hides the real <input type="file"> behind a button
  // (display:none), so pick via fireEvent.change like the composer tests do.
  function pickFile(scope: HTMLElement, file: File) {
    const input = scope.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(input, { target: { files: [file] } });
  }

  it("maps columns from the file header and renders the per-row error report", async () => {
    renderEval();
    await screen.findByTestId("cases-empty");
    await userEvent.click(screen.getByRole("button", { name: "⇪ Import" }));

    const dialog = await screen.findByRole("dialog");
    pickFile(dialog, csvFile("question,answer,expected\nq1,a1,e1\n"));
    // The CSV header is read locally so the mapping selects offer real columns.
    await waitFor(() =>
      expect(within(dialog).getByRole("combobox", { name: "Input (prompt)" })).toHaveValue("question"),
    );
    expect(within(dialog).getByRole("combobox", { name: "Output (candidate)" })).toHaveValue("answer");
    expect(within(dialog).getByRole("combobox", { name: "Reference (expected)" })).toHaveValue("expected");

    await userEvent.click(within(dialog).getByRole("button", { name: "Import" }));

    await waitFor(() => expect(importRequests).toHaveLength(1));
    expect(importRequests[0]).toEqual({
      filename: "cases.csv",
      mapping: JSON.stringify({ input: "question", output: "answer", reference: "expected" }),
      set_id: null,
      set_name: null,
    });

    const report = await screen.findByTestId("import-report");
    expect(report).toHaveTextContent("2 / 3 rows imported");
    expect(report).toHaveTextContent("1 row error");
    // Per-row detail: row number, column and message are all rendered.
    expect(report).toHaveTextContent("answer");
    expect(report).toHaveTextContent(/output is empty/i);
  });

  it("imports into a brand-new set when one is named", async () => {
    renderEval();
    await screen.findByTestId("cases-empty");
    await userEvent.click(screen.getByRole("button", { name: "⇪ Import" }));
    const dialog = await screen.findByRole("dialog");
    pickFile(dialog, csvFile("question,answer,expected\nq1,a1,e1\n"));
    await waitFor(() =>
      expect(within(dialog).getByRole("combobox", { name: "Input (prompt)" })).toHaveValue("question"),
    );
    await userEvent.click(within(dialog).getByRole("radio", { name: "New set" }));
    await userEvent.type(within(dialog).getByLabelText("New set name"), "imported");
    await userEvent.click(within(dialog).getByRole("button", { name: "Import" }));

    await waitFor(() => expect(importRequests).toHaveLength(1));
    expect(importRequests[0].set_name).toBe("imported");
  });

  it("handles the queued 202 path through the task machinery", async () => {
    importConfig.queued = true;
    renderEval();
    await screen.findByTestId("cases-empty");
    await userEvent.click(screen.getByRole("button", { name: "⇪ Import" }));
    const dialog = await screen.findByRole("dialog");
    pickFile(dialog, csvFile("question,answer,expected\nq1,a1,e1\n"));
    await waitFor(() =>
      expect(within(dialog).getByRole("combobox", { name: "Input (prompt)" })).toHaveValue("question"),
    );
    await userEvent.click(within(dialog).getByRole("button", { name: "Import" }));

    // 202 renders the queued state rather than a fabricated report; the real
    // report arrives on the task (openapi.yaml:1386-1389).
    expect(await within(dialog).findByText(/queued as task task-import-1/i)).toBeInTheDocument();
    expect(screen.queryByTestId("import-report")).not.toBeInTheDocument();
  });
});
