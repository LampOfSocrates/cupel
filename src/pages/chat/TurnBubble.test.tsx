import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MantineProvider } from "@mantine/core";
import { TurnBubble } from "./TurnBubble";
import type { Turn } from "../../api/types";

const mockTurn: Turn = {
  id: "turn_1",
  conversation_id: "conv_1",
  role: "assistant",
  author: "Assistant",
  content: "Hello world!",
  created_at: new Date().toISOString(),
  envelope: {
    region: "us-east-1",
    timezone: "UTC",
  },
};

function renderWithMantine(ui: React.ReactNode) {
  return render(<MantineProvider>{ui}</MantineProvider>);
}

describe("TurnBubble", () => {
  it("renders assistant turn with action icon buttons and accessible labels", () => {
    const onRate = vi.fn();
    const onFork = vi.fn();
    const onTrace = vi.fn();
    const onCollect = vi.fn();

    renderWithMantine(
      <TurnBubble
        turn={mockTurn}
        onRate={onRate}
        onFork={onFork}
        onTrace={onTrace}
        onCollect={onCollect}
        shareUrl="https://example.com/share/turn_1"
      />
    );

    expect(screen.getByRole("button", { name: "Thumbs up" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Thumbs down" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Copy message" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Copy link to turn" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Fork turn" })).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Collect into eval benchmark" })
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Open trace" })).toBeInTheDocument();
  });

  it("calls rating callback when rating button is clicked", async () => {
    const user = userEvent.setup();
    const onRate = vi.fn();

    renderWithMantine(<TurnBubble turn={mockTurn} onRate={onRate} />);

    const thumbsUp = screen.getByRole("button", { name: "Thumbs up" });
    await user.click(thumbsUp);

    expect(onRate).toHaveBeenCalledWith("up");
  });
});
