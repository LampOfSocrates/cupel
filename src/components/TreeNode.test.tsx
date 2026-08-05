import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MantineProvider } from "@mantine/core";
import { TreeBranch, TreeNode } from "./TreeNode";

// Sketch-08 node reuse contract (skein-phases.md:40 "reuse 08's node
// components, structure-only"): kind palettes match the trace sketch's agent/
// tool/llm families; dimmed = disabled styling (feature-spec.md:25).

function renderNode(ui: React.ReactNode) {
  return render(<MantineProvider env="test">{ui}</MantineProvider>);
}

describe("TreeNode", () => {
  it("renders label, meta, and the kind palette from sketch 08", () => {
    renderNode(<TreeNode label="Router" meta="0.4s" kind="agent" />);
    expect(screen.getByText("Router")).toBeInTheDocument();
    expect(screen.getByText("0.4s")).toBeInTheDocument();
    const card = screen.getByRole("button", { name: "Open Router" });
    // agent family: #EEEDFE fill, #534AB7 stroke (sketches/clean/08-trace.svg)
    expect(card.style.background).toBe("rgb(238, 237, 254)");
    expect(card.style.border).toContain("1px solid");
  });

  it("supports tool and llm kinds with their own fills", () => {
    renderNode(
      <>
        <TreeNode label="lookup_order" kind="tool" />
        <TreeNode label="LLM sonnet" kind="llm" />
      </>,
    );
    expect(
      screen.getByRole("button", { name: "Open lookup_order" }).style.background,
    ).toBe("rgb(225, 245, 238)"); // #E1F5EE
    expect(screen.getByRole("button", { name: "Open LLM sonnet" }).style.background).toBe(
      "rgb(250, 236, 231)", // #FAECE7
    );
  });

  it("dims when dimmed and fires onClick", async () => {
    const onClick = vi.fn();
    const user = userEvent.setup();
    renderNode(<TreeNode label="Shipping" dimmed onClick={onClick} />);
    const card = screen.getByRole("button", { name: "Open Shipping" });
    expect(card.style.opacity).toBe("0.5");
    await user.click(card);
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("TreeBranch indents children under a connector rail", () => {
    renderNode(
      <TreeBranch>
        <TreeNode label="Child A" />
        <TreeNode label="Child B" />
      </TreeBranch>,
    );
    expect(screen.getByText("Child A")).toBeInTheDocument();
    expect(screen.getByText("Child B")).toBeInTheDocument();
  });
});
