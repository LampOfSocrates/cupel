import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes, useParams } from "react-router";
import { MantineProvider } from "@mantine/core";
import { AppContext } from "../AppContext";
import { testAppState } from "../test/render";
import {
  endpointsRequests,
  mockModels,
  replayTurnRequests,
} from "../test/msw/handlers";
import { ForkModal } from "./ForkModal";

// Contract under test — POST /agenttrees/{tree}/replay/turn (openapi.yaml:
// 623-652): ReplayTurnRequest {conversation_id, turn_id, endpoints (minItems
// 1), config?, context_policy pinned frozen} (:1556-1574); 202
// ReplayTurnAccepted "one task_id + new conversation_id per endpoint"
// (feature-spec.md:71) + run_id (:1576-1594). Endpoints fed by GET
// /agenttrees/{tree}/endpoints (openapi.yaml:154-172).

function ChatProbe() {
  const { id } = useParams();
  return <div>chat-probe {id}</div>;
}
function RunProbe() {
  const { id } = useParams();
  return <div>run-probe {id}</div>;
}

// Custom provider (not renderApp): refreshConversations is a spy so the
// sidebar-refresh signal is assertable; models pre-seeded so the optional
// model select has data without a fetch.
function renderModal(
  props: Partial<Parameters<typeof ForkModal>[0]> = {},
  refreshSpy = vi.fn(),
) {
  const view = render(
    <MantineProvider env="test">
      <AppContext.Provider
        value={{
          ...testAppState,
          conversationsVersion: 0,
          refreshConversations: refreshSpy,
          models: mockModels,
          ensureModels: () => {},
        }}
      >
        <MemoryRouter initialEntries={["/origin"]}>
          <Routes>
            <Route
              path="/origin"
              element={
                <ForkModal
                  conversationId="c1"
                  turnId="t2"
                  opened
                  onClose={() => {}}
                  {...props}
                />
              }
            />
            <Route path="/chat/:id" element={<ChatProbe />} />
            <Route path="/evaluations/:id" element={<RunProbe />} />
          </Routes>
        </MemoryRouter>
      </AppContext.Provider>
    </MantineProvider>,
  );
  return { refreshSpy, ...view };
}

async function pickEndpoints(user: ReturnType<typeof userEvent.setup>, names: string[]) {
  await user.click(await screen.findByRole("combobox", { name: "Endpoints" }));
  for (const name of names) {
    await user.click(await screen.findByRole("option", { name }));
  }
}

describe("ForkModal", () => {
  it("lists endpoints from GET /agenttrees/{tree}/endpoints; Fork requires at least one", async () => {
    const user = userEvent.setup();
    renderModal();

    await screen.findByRole("combobox", { name: "Endpoints" });
    expect(endpointsRequests).toEqual(["agent1"]);
    // endpoints[] minItems 1 (openapi.yaml:1564) — disabled until one picked
    expect(screen.getByRole("button", { name: "Fork ⑂" })).toBeDisabled();

    await pickEndpoints(user, ["prod"]);
    expect(screen.getByRole("button", { name: "Fork ⑂" })).toBeEnabled();
  });

  it("fires the exact frozen-pinned ReplayTurnRequest — no config key when nothing optional is set", async () => {
    const user = userEvent.setup();
    renderModal();

    await pickEndpoints(user, ["prod", "staging"]);
    await user.click(screen.getByRole("button", { name: "Fork ⑂" }));

    await waitFor(() => expect(replayTurnRequests).toHaveLength(1));
    // context_policy frozen is client-pinned (client.ts api.replayTurn;
    // openapi.yaml:1570-1574); untouched config = absent, not null.
    expect(replayTurnRequests[0]).toEqual({
      tree: "agent1",
      body: {
        conversation_id: "c1",
        turn_id: "t2",
        endpoints: ["ep_agent1_prod", "ep_agent1_staging"],
        context_policy: "frozen",
      },
    });
  });

  it("optional model + instruction version travel inside config (agent_id rides with the version)", async () => {
    const user = userEvent.setup();
    renderModal({ agentId: "ag_refunds" });

    await pickEndpoints(user, ["prod"]);
    await user.click(screen.getByRole("combobox", { name: "Model (optional)" }));
    await user.click(await screen.findByRole("option", { name: "Claude Sonnet 5" }));
    // versions from GET …/agents/ag_refunds/instructions (fixture: v1 only)
    await user.click(
      await screen.findByRole("combobox", { name: "Instruction version (optional)" }),
    );
    await user.click(await screen.findByRole("option", { name: "v1" }));
    await user.click(screen.getByRole("button", { name: "Fork ⑂" }));

    await waitFor(() => expect(replayTurnRequests).toHaveLength(1));
    expect(replayTurnRequests[0].body.config).toEqual({
      model: "claude-sonnet-5",
      agent_id: "ag_refunds",
      instruction_version: 1,
    });
  });

  it("202 renders one row per endpoint; Open in Chat routes to the fork; sidebar refresh fires", async () => {
    const user = userEvent.setup();
    const { refreshSpy } = renderModal();

    await pickEndpoints(user, ["prod", "staging"]);
    await user.click(screen.getByRole("button", { name: "Fork ⑂" }));

    // "one task_id + new conversation_id per endpoint" (feature-spec.md:71)
    const results = await screen.findByTestId("fork-results");
    expect(results).toHaveTextContent("prod");
    expect(results).toHaveTextContent("staging");
    expect(screen.getAllByText("queued")).toHaveLength(2);
    // parent fork chip/count changed → sidebar reload signal
    expect(refreshSpy).toHaveBeenCalledTimes(1);

    // "Open in Chat: any fork can be opened in the main Chat page"
    // (feature-spec.md:70) — first result is endpoint 1's fork conversation.
    // (Anchor has no href → no implicit link role; query by text.)
    await user.click(screen.getAllByText("Open in Chat ↗")[0]);
    await screen.findByText("chat-probe c-fork-1-1");
  });

  // The form resets per open by MOUNTING per open — Mantine's Modal does not
  // render its children while closed, so the body's useState initialisers run
  // again. This is load-bearing: it replaced an explicit reset effect.
  it("reopening starts from a fresh form, not the previous open's selection", async () => {
    const user = userEvent.setup();
    function Harness() {
      const [opened, setOpened] = useState(true);
      return (
        <>
          <button onClick={() => setOpened((o) => !o)}>toggle</button>
          <ForkModal
            conversationId="c1"
            turnId="t2"
            opened={opened}
            onClose={() => setOpened(false)}
          />
        </>
      );
    }
    render(
      <MantineProvider env="test">
        <AppContext.Provider
          value={{
            ...testAppState,
            conversationsVersion: 0,
            refreshConversations: vi.fn(),
            models: mockModels,
            ensureModels: () => {},
          }}
        >
          <MemoryRouter>
            <Harness />
          </MemoryRouter>
        </AppContext.Provider>
      </MantineProvider>,
    );

    await pickEndpoints(user, ["prod"]);
    expect(screen.getByRole("button", { name: "Fork ⑂" })).toBeEnabled();

    await user.click(screen.getByRole("button", { name: "toggle" }));
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "Fork ⑂" })).toBeNull(),
    );
    await user.click(screen.getByRole("button", { name: "toggle" }));

    // endpoints[] is empty again → Fork disabled, exactly as on a first open.
    expect(await screen.findByRole("button", { name: "Fork ⑂" })).toBeDisabled();
  });

  it("View evaluation routes to the evaluation backing the fork pivot", async () => {
    const user = userEvent.setup();
    renderModal();

    await pickEndpoints(user, ["prod"]);
    await user.click(screen.getByRole("button", { name: "Fork ⑂" }));
    await screen.findByTestId("fork-results");

    // run_id → GET …/runs/{runId} route (openapi.yaml:1581-1585).
    await user.click(screen.getByText("View evaluation"));
    await screen.findByText("run-probe run-1");
  });
});
