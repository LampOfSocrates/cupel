// Span trees and their lazily-loaded payloads.
import { http, HttpResponse } from "msw";
import type { SpanPayload, Trace } from "../../../api/types";
import { BASE, envelope, treeGate } from "../state";

// --------------------------------------------------------------- trace state
// GET /agenttrees/{tree}/turns/{turnId}/trace (openapi.yaml:696-721) + GET
// /spans/{spanId}/payload (:723-744). Span shape openapi.yaml:
// 1668-1690; payload_ref = span id, mirroring the real mock (engine.py:59).
// t2: COMPLETED agent→tool→llm trace incl. an ERROR span ("Errors mark the
// span red", feature-spec.md:145). t-live: still-generating trace (running
// root span) for live-merge tests — spans stream on /tasks/stream
// (feature-spec.md:146) via taskStreamRig.emit("span", …).
function seedTraces(): Record<string, Trace> {
  return {
    t2: {
      turn_id: "t2",
      envelope,
      totals: { wall_time_ms: 4900, tokens_in: 6410, tokens_out: 1240, cost: 0.011 },
      spans: [
        {
          id: "sp-root", parent_id: null, type: "agent", name: "Refunds agent",
          start: "2026-08-04T09:57:10.000Z", end: "2026-08-04T09:57:14.900Z",
          tokens_in: null, tokens_out: null, cost: null, model: null,
          status: "ok", error: null, payload_ref: "sp-root",
        },
        {
          id: "sp-tool", parent_id: "sp-root", type: "tool", name: "lookup_order",
          start: "2026-08-04T09:57:10.400Z", end: "2026-08-04T09:57:11.000Z",
          tokens_in: null, tokens_out: null, cost: null, model: null,
          status: "ok", error: null, payload_ref: "sp-tool",
        },
        {
          id: "sp-llm", parent_id: "sp-root", type: "llm", name: "LLM sonnet",
          start: "2026-08-04T09:57:11.000Z", end: "2026-08-04T09:57:12.800Z",
          tokens_in: 2143, tokens_out: 663, cost: 0.0041, model: "claude-sonnet-5",
          status: "ok", error: null, payload_ref: "sp-llm",
        },
        {
          id: "sp-err", parent_id: "sp-root", type: "tool", name: "refund",
          start: "2026-08-04T09:57:12.800Z", end: "2026-08-04T09:57:13.400Z",
          tokens_in: null, tokens_out: null, cost: null, model: null,
          status: "error", error: "refund service unreachable (502)",
          payload_ref: "sp-err",
        },
      ],
    },
    "t-live": {
      turn_id: "t-live",
      envelope,
      totals: { wall_time_ms: 1200, tokens_in: 900, tokens_out: 60, cost: 0.0009 },
      spans: [
        {
          id: "sp-live-root", parent_id: null, type: "agent", name: "Concierge",
          start: "2026-08-04T10:00:00.000Z", end: null,
          tokens_in: null, tokens_out: null, cost: null, model: null,
          status: "running", error: null, payload_ref: "sp-live-root",
        },
        {
          id: "sp-live-llm", parent_id: "sp-live-root", type: "llm", name: "LLM sonnet",
          start: "2026-08-04T10:00:00.200Z", end: "2026-08-04T10:00:01.200Z",
          tokens_in: 900, tokens_out: 60, cost: 0.0009, model: "claude-sonnet-5",
          status: "ok", error: null, payload_ref: "sp-live-llm",
        },
      ],
    },
  };
}
export const mockTraces: Record<string, Trace> = seedTraces();
export const traceRequests: string[] = []; // turn ids seen by GET trace

// SpanPayload (openapi.yaml:1714-1723): "LLM spans carry prompt/response;
// tool spans carry args/result".
function seedSpanPayloads(): Record<string, SpanPayload> {
  return {
    "sp-root": { span_id: "sp-root", prompt: null, response: null, args: null, result: null },
    "sp-tool": {
      span_id: "sp-tool",
      prompt: null,
      response: null,
      args: { order_id: "4413" },
      result: { status: "found", total: "£120.00" },
    },
    "sp-llm": {
      span_id: "sp-llm",
      prompt: "You are a refunds agent. Be brief.\n\nHow do refunds work?",
      response: "Approved refunds land in 3-5 days.",
      args: null,
      result: null,
    },
    "sp-err": {
      span_id: "sp-err",
      prompt: null,
      response: null,
      args: { order_id: "4413", amount: "£120.00" },
      result: null,
    },
    "sp-live-llm": {
      span_id: "sp-live-llm",
      prompt: "You are Concierge.\n\nHi",
      response: "Hello! How can I help?",
      args: null,
      result: null,
    },
  };
}
export const mockSpanPayloads: Record<string, SpanPayload> = seedSpanPayloads();
export const spanPayloadRequests: string[] = []; // span ids seen by GET payload

export const traceHandlers = [
  // GET /agenttrees/{tree}/turns/{turnId}/trace (openapi.yaml:696-721) —
  // "Span tree for a turn".
  http.get(`${BASE}/agenttrees/:tree/turns/:turnId/trace`, ({ params }) => {
    const id = params.turnId as string;
    traceRequests.push(id);
    const denied = treeGate(params.tree as string);
    if (denied) return denied;
    const found = mockTraces[id];
    if (!found) {
      return HttpResponse.json({ code: "not_found", message: "turn not found" }, { status: 404 });
    }
    return HttpResponse.json(found);
  }),

  // GET /spans/{spanId}/payload (openapi.yaml:723-744) — "Lazy-loaded span
  // payload"; requests captured so tests can assert laziness (drawer-open only).
  http.get(`${BASE}/spans/:spanId/payload`, ({ params }) => {
    const id = params.spanId as string;
    spanPayloadRequests.push(id);
    const found = mockSpanPayloads[id];
    if (!found) {
      return HttpResponse.json({ code: "not_found", message: "span not found" }, { status: 404 });
    }
    return HttpResponse.json(found);
  }),
];

export function resetTraces() {
  for (const key of Object.keys(mockTraces)) delete mockTraces[key];
  Object.assign(mockTraces, seedTraces());
  traceRequests.length = 0;
  for (const key of Object.keys(mockSpanPayloads)) delete mockSpanPayloads[key];
  Object.assign(mockSpanPayloads, seedSpanPayloads());
  spanPayloadRequests.length = 0;
}
