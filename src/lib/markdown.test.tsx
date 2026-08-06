import { useState } from "react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { MantineProvider } from "@mantine/core";
import { marked } from "marked";
import { Markdown } from "./markdown";

// docs/review-2026-08-05.md A4: `marked()` + `DOMPurify.sanitize()` ran on
// every render, so one streamed token re-parsed every turn in the transcript
// and every cell in a run grid ("~100–500 ms of main-thread work per second on
// a 30-turn conversation"). The component is memoized and the parse is keyed on
// [content]; these tests pin that the parser is invoked per CONTENT CHANGE, not
// per render.

vi.mock("marked", async (importOriginal) => {
  const actual = await importOriginal<typeof import("marked")>();
  return { marked: vi.fn(actual.marked) };
});

const parses = () => vi.mocked(marked).mock.calls.length;

function renderIn(ui: React.ReactNode) {
  return render(<MantineProvider env="test">{ui}</MantineProvider>);
}

beforeEach(() => {
  vi.mocked(marked).mockClear();
});

describe("Markdown", () => {
  it("still renders sanitized markdown", () => {
    renderIn(<Markdown content="**world** <script>alert(1)</script>" />);
    expect(screen.getByText("world").tagName).toBe("STRONG");
    expect(document.querySelector("script")).toBeNull();
  });

  it("a parent re-render with unchanged content does not re-invoke the parser", () => {
    function Parent({ tick }: { tick: number }) {
      return (
        <div data-tick={tick}>
          <Markdown content="unchanged **content**" />
        </div>
      );
    }
    const { rerender } = renderIn(<Parent tick={0} />);
    expect(parses()).toBe(1);
    for (let i = 1; i <= 5; i++) {
      rerender(
        <MantineProvider env="test">
          <Parent tick={i} />
        </MantineProvider>,
      );
    }
    expect(parses()).toBe(1);
  });

  it("changed content re-parses exactly once", () => {
    const { rerender } = renderIn(<Markdown content="first" />);
    rerender(
      <MantineProvider env="test">
        <Markdown content="second" />
      </MantineProvider>,
    );
    expect(parses()).toBe(2);
    expect(screen.getByText("second")).toBeInTheDocument();
  });

  // The shape the review measured: a 10-turn transcript with a streaming draft
  // taking 20 tokens. Cost is now the 10 static turns parsed once + one parse
  // per token (31), instead of re-parsing all 11 bubbles per token (231).
  it("a streaming draft costs one parse per token, not one per turn per token", async () => {
    function Transcript() {
      const [draft, setDraft] = useState("");
      return (
        <div>
          {Array.from({ length: 10 }, (_, i) => (
            <Markdown key={i} content={`turn ${i} with **markdown**`} />
          ))}
          <Markdown content={draft} />
          <button onClick={() => setDraft((d) => `${d}token `)}>token</button>
        </div>
      );
    }
    renderIn(<Transcript />);
    expect(parses()).toBe(11);
    const button = screen.getByRole("button", { name: "token" });
    for (let i = 0; i < 20; i++) fireEvent.click(button);
    expect(parses()).toBe(31);
  });
});
