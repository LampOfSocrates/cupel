import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MantineProvider } from "@mantine/core";
import { TurnBubble } from "./TurnBubble";
import type { Turn } from "../../api/types";

const mockAssistantTurn: Turn = {
  id: "turn-123",
  conversation_id: "conv-456",
  role: "assistant",
  author: "Assistant",
  content: "Hello world!",
  created_at: "2026-08-05T12:00:00Z",
  envelope: {
    system_date: "2026-08-05",
    timezone: "UTC",
    region: "US",
    locale: "en-US",
  },
};

const mockUserTurn: Turn = {
  id: "turn-124",
  conversation_id: "conv-456",
  role: "user",
  author: "User",
  content: "Hi there!",
  created_at: "2026-08-05T11:59:00Z",
};

function renderBubble(props: Partial<React.ComponentProps<typeof TurnBubble>>) {
  return render(
    <MantineProvider env="test">
      <TurnBubble
        turn={mockAssistantTurn}
        onRate={vi.fn()}
        {...props}
      />
    </MantineProvider>,
  );
}

describe("TurnBubble", () => {
  it("renders assistant turn with action icons and tooltips", () => {
    renderBubble({
      onFork: vi.fn(),
      onCollect: vi.fn(),
      onTrace: vi.fn(),
      shareUrl: "https://example.com/share",
    });

    expect(screen.getByRole("button", { name: "Thumbs up" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Thumbs down" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Copy message" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Copy link to turn" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Fork turn" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Collect into eval benchmark" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Open trace" })).toBeInTheDocument();
  });

  it("does not render action buttons for user turns", () => {
    render(
      <MantineProvider env="test">
        <TurnBubble turn={mockUserTurn} onRate={vi.fn()} />
      </MantineProvider>,
    );

    expect(screen.queryByRole("button", { name: "Thumbs up" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Copy message" })).not.toBeInTheDocument();
  });

  it("updates copy button label when clicked", async () => {
    const user = userEvent.setup();
    renderBubble({});

    const copyBtn = screen.getByRole("button", { name: "Copy message" });
    await user.click(copyBtn);

    expect(screen.getByRole("button", { name: "Copied" })).toBeInTheDocument();
  });
});
