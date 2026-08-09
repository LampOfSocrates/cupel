import { describe, expect, it } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Route, Routes } from "react-router";
import { renderApp } from "../test/render";
import {
  mockTraces,
  spanPayloadRequests,
  taskStreamRig,
  traceRequests,
} from "../test/msw/handlers";
import { TracePage } from "./TracePage";

// Contract under test — trace view:
// - GET /agenttrees/{tree}/turns/{turnId}/trace (openapi.yaml:696-721): "The
//   trace (totals + flat span list with parent links)"; header totals
//   ("wall time, tokens in/out, cost", feature-spec.md:147) + envelope
//   ("Shown in the trace header", openapi.yaml:1700).
// - Two synced layers (feature-spec.md:146-148): call tree (nodes colored by
//   type, badged "time · tokens in→out") + waterfall ("one row per span, bars
//   positioned on the turn's timeline").
// - Span drawer (feature-spec.md:149): "full prompt/response for LLM spans,
//   args/result for tool spans, model, exact token counts, cost,
//   status/error. Errors mark the span red in both views"; payload
//   lazy-loaded via GET /spans/{spanId}/payload (openapi.yaml:723-744).
// - Live spans (feature-spec.md:150): "spans appear live while the turn is
//   generating (same SSE channel as tasks)" — span frames on /tasks/stream
//   (SpanEvent, openapi.yaml:1788-1794).

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function renderTrace(turnId: string) {
  return renderApp(
    <Routes>
      <Route path="/trace/:turnId" element={<TracePage />} />
    </Routes>,
    { route: `/trace/${turnId}` },
  );
}

describe("TracePage", () => {
  it("header shows turn totals + envelope chip from the trace", async () => {
    renderTrace("t2");
    const heading = await screen.findByRole("heading", { level: 4 });
    // sketch 08 density: "Trace · turn 2 · 4.9s · 6,410→1,240 tok · $0.011"
    expect(heading).toHaveTextContent("Trace · t2 · 4.9s · 6410→1240 tok · $0.0110");
    // envelope "shown in the trace header" (openapi.yaml:1700; cupel-phases.md:25)
    expect(screen.getByTestId("envelope-chip")).toHaveTextContent(
      "2026-08-02 · Europe/London · GB · en-GB",
    );
  });

  it("call tree nests spans via parent links with kind palettes and time·token badges", async () => {
    renderTrace("t2");
    const tree = await screen.findByTestId("call-tree");

    // one node per span, sketch-08 palettes via TreeNode kinds
    const root = within(tree).getByRole("button", { name: "Open Refunds agent" });
    const tool = within(tree).getByRole("button", { name: "Open lookup_order" });
    const llm = within(tree).getByRole("button", { name: "Open LLM sonnet" });
    expect(root.style.background).toBe("rgb(238, 237, 254)"); // agent #EEEDFE
    expect(tool.style.background).toBe("rgb(225, 245, 238)"); // tool #E1F5EE
    expect(llm.style.background).toBe("rgb(250, 236, 231)"); // llm #FAECE7

    // badge "time · tokens in→out" (feature-spec.md:147); tool = time alone
    expect(llm).toHaveTextContent("1.8s · 2143→663");
    expect(tool).toHaveTextContent("0.6s");

    // nesting: children sit under the TreeBranch connector rail, the root
    // does not (parent_id null → top level)
    expect(tool.closest('div[style*="border-left"]')).not.toBeNull();
    expect(llm.closest('div[style*="border-left"]')).not.toBeNull();
    expect(root.closest('div[style*="border-left"]')).toBeNull();
  });

  it("waterfall renders one row per span in trace order", async () => {
    renderTrace("t2");
    const waterfall = await screen.findByTestId("waterfall");
    const bars = [0, 1, 2, 3].map((i) => within(waterfall).getByTestId(`wf-bar-${i}`));
    expect(bars.map((b) => b.getAttribute("data-span-id"))).toEqual([
      "sp-root",
      "sp-tool",
      "sp-llm",
      "sp-err",
    ]);
    expect(within(waterfall).queryByTestId("wf-bar-4")).not.toBeInTheDocument();
  });

  it("error spans are red in both views: node border/badge + red waterfall bar", async () => {
    renderTrace("t2");
    const tree = await screen.findByTestId("call-tree");
    const errNode = within(tree).getByRole("button", { name: "Open refund" });
    expect(errNode).toHaveAttribute("data-error", "true");
    expect(within(errNode).getByText("error")).toBeInTheDocument(); // red badge
    // waterfall row for sp-err marked as error (bar painted red, not type color)
    expect(screen.getByTestId("wf-bar-3")).toHaveAttribute("data-error", "true");
  });

  it("clicking a tree node selects the span in both layers and opens the drawer (lazy payload fetch)", async () => {
    const user = userEvent.setup();
    renderTrace("t2");
    const tree = await screen.findByTestId("call-tree");
    // lazy: NOTHING fetched until a drawer opens (openapi.yaml:729-730)
    expect(spanPayloadRequests).toEqual([]);

    await user.click(within(tree).getByRole("button", { name: "Open LLM sonnet" }));

    // synced selection: highlighted in the tree AND the waterfall
    expect(
      within(tree).getByRole("button", { name: "Open LLM sonnet" }),
    ).toHaveAttribute("data-selected", "true");
    expect(screen.getByTestId("wf-bar-2")).toHaveAttribute("data-selected", "true");

    // drawer: LLM span → model, exact tokens, cost, prompt/response
    const drawer = await screen.findByRole("dialog");
    expect(within(drawer).getByText("Span: LLM sonnet")).toBeInTheDocument();
    expect(within(drawer).getByTestId("span-model")).toHaveTextContent("claude-sonnet-5");
    expect(within(drawer).getByTestId("span-stats")).toHaveTextContent(
      "2143→663 tok · $0.0041 · 1.8s",
    );
    await within(drawer).findByText(/You are a refunds agent/);
    expect(within(drawer).getByText("PROMPT")).toBeInTheDocument();
    expect(within(drawer).getByText("RESPONSE")).toBeInTheDocument();
    expect(within(drawer).getByText(/Approved refunds land in 3-5 days/)).toBeInTheDocument();
    expect(spanPayloadRequests).toEqual(["sp-llm"]); // fetched on open, once
  });

  it("clicking a waterfall bar selects the tree node; tool payload renders args/result JSON", async () => {
    const user = userEvent.setup();
    renderTrace("t2");
    await screen.findByTestId("waterfall");

    await user.click(screen.getByTestId("wf-bar-1")); // sp-tool
    const tree = screen.getByTestId("call-tree");
    expect(
      within(tree).getByRole("button", { name: "Open lookup_order" }),
    ).toHaveAttribute("data-selected", "true");

    const drawer = await screen.findByRole("dialog");
    await within(drawer).findByText("ARGS");
    expect(within(drawer).getByText(/"order_id": "4413"/)).toBeInTheDocument();
    expect(within(drawer).getByText("RESULT")).toBeInTheDocument();
    expect(within(drawer).getByText(/"total": "£120.00"/)).toBeInTheDocument();
    expect(spanPayloadRequests).toEqual(["sp-tool"]);
  });

  it("error span drawer shows the status/error prominently", async () => {
    const user = userEvent.setup();
    renderTrace("t2");
    const tree = await screen.findByTestId("call-tree");
    await user.click(within(tree).getByRole("button", { name: "Open refund" }));
    const drawer = await screen.findByRole("dialog");
    expect(within(drawer).getByTestId("span-error")).toHaveTextContent(
      "refund service unreachable (502)",
    );
  });

  it("a completed trace never subscribes to /tasks/stream", async () => {
    renderTrace("t2"); // no running span → live heuristic says no
    await screen.findByTestId("call-tree");
    await sleep(50);
    expect(taskStreamRig.clients).toBe(0);
    expect(screen.queryByTestId("trace-live")).not.toBeInTheDocument();
  });

  it("running trace subscribes; matching span frames insert/update rows live; terminal closes it", async () => {
    renderTrace("t-live"); // fixture root span status running (end null)
    await screen.findByTestId("call-tree");
    expect(screen.getByTestId("trace-live")).toBeInTheDocument();
    expect(screen.getByTestId("wf-bar-0")).toHaveAttribute("data-running", "true");
    await waitFor(() => expect(taskStreamRig.clients).toBe(1));

    // a NEW span opens server-side → frame inserts a row in both layers
    taskStreamRig.emit("span", {
      turn_id: "t-live",
      span: {
        id: "sp-live-tool", parent_id: "sp-live-root", type: "tool", name: "search_kb",
        start: "2026-08-04T10:00:01.300Z", end: null,
        tokens_in: null, tokens_out: null, cost: null, model: null,
        status: "running", error: null, payload_ref: "sp-live-tool",
      },
    });
    const tree = screen.getByTestId("call-tree");
    await within(tree).findByRole("button", { name: "Open search_kb" });
    expect(screen.getByTestId("wf-bar-2")).toHaveAttribute("data-span-id", "sp-live-tool");

    // frames from OTHER turns are ignored
    taskStreamRig.emit("span", {
      turn_id: "someone-else",
      span: {
        id: "sp-foreign", parent_id: null, type: "agent", name: "Foreign",
        start: "2026-08-04T10:00:01.000Z", end: null,
        tokens_in: null, tokens_out: null, cost: null, model: null,
        status: "running", error: null, payload_ref: "sp-foreign",
      },
    });
    await sleep(30);
    expect(within(tree).queryByRole("button", { name: "Open Foreign" })).not.toBeInTheDocument();

    // spans close server-side (merge REPLACES by id); once none are running
    // the page refetches the authoritative totals and unsubscribes. Fixture
    // mutated to the finished state first — the refetch reads it.
    const fetches = traceRequests.length;
    const live = mockTraces["t-live"];
    live.totals = { wall_time_ms: 2100, tokens_in: 900, tokens_out: 60, cost: 0.0009 };
    live.spans = live.spans.map((s) => ({
      ...s,
      status: "ok" as const,
      end: s.end ?? "2026-08-04T10:00:02.100Z",
    }));
    taskStreamRig.emit("span", {
      turn_id: "t-live",
      span: {
        id: "sp-live-tool", parent_id: "sp-live-root", type: "tool", name: "search_kb",
        start: "2026-08-04T10:00:01.300Z", end: "2026-08-04T10:00:01.900Z",
        tokens_in: null, tokens_out: null, cost: null, model: null,
        status: "ok", error: null, payload_ref: "sp-live-tool",
      },
    });
    taskStreamRig.emit("span", {
      turn_id: "t-live",
      span: {
        id: "sp-live-root", parent_id: null, type: "agent", name: "Concierge",
        start: "2026-08-04T10:00:00.000Z", end: "2026-08-04T10:00:02.100Z",
        tokens_in: null, tokens_out: null, cost: null, model: null,
        status: "ok", error: null, payload_ref: "sp-live-root",
      },
    });

    // terminal transition → one refetch (server totals repaint the header)
    await waitFor(() => expect(traceRequests.length).toBe(fetches + 1));
    await waitFor(() =>
      expect(screen.getByRole("heading", { level: 4 })).toHaveTextContent("2.1s"),
    );
    expect(screen.queryByTestId("trace-live")).not.toBeInTheDocument();
    expect(screen.queryByText("running…")).not.toBeInTheDocument();

    // stream aborted client-side: a late frame changes nothing (the jsdom
    // transport can't drop `clients`, so the observable guarantee is no merge)
    taskStreamRig.emit("span", {
      turn_id: "t-live",
      span: {
        id: "sp-late", parent_id: null, type: "tool", name: "late_span",
        start: "2026-08-04T10:00:02.200Z", end: null,
        tokens_in: null, tokens_out: null, cost: null, model: null,
        status: "running", error: null, payload_ref: "sp-late",
      },
    });
    await sleep(30);
    expect(
      within(screen.getByTestId("call-tree")).queryByRole("button", { name: "Open late_span" }),
    ).not.toBeInTheDocument();
  });

  it("unknown turn renders the API error", async () => {
    renderTrace("t-nope");
    await screen.findByText("Could not load trace");
    expect(screen.getByText("turn not found")).toBeInTheDocument();
  });
});
