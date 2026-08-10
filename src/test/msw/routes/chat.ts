// Chat: the SSE/JSON generation endpoint and the attachment upload that feeds
// it. Both carry test knobs (`chatConfig`, `uploadConfig`) so a test can step
// the stream or force a 413 without building real payloads.
import { http, HttpResponse } from "msw";
import type { Attachment, ChatRequest, ChatResponse, Turn } from "../../../api/types";
import {
  apiError,
  BASE,
  cancelledTasks,
  captureLlmHeaders,
  conv,
  counters,
  enabledTreeGate,
  envelope,
} from "../state";
import { mockRoots } from "./conversations";

// -------------------------------------------------------------- upload state
// POST /upload knobs (openapi.yaml:523-554). maxBytes mirrors the real mock's
// Phase-1 limit (mock/config.py:15 MAX_UPLOAD_BYTES = 5 MiB) — tests shrink it
// to simulate 413 without building multi-MB files. `gate` (when set) is
// awaited before responding so tests can observe the uploading state.
export const uploadConfig: {
  maxBytes: number;
  gate: (() => Promise<void>) | null;
} = { maxBytes: 5 * 1024 * 1024, gate: null };

export const uploadRequests: Array<{ filename: string; size: number }> = [];

// ---------------------------------------------------------------- chat state
// Knobs for the chat SSE handler. `gate` (when set) is awaited before each
// token and before done — tests use it to step the stream deterministically.
// `errorAfter` emits an `error` frame after N tokens instead of finishing.
export const chatConfig: {
  tokens: string[];
  delayMs: number;
  gate: (() => Promise<void>) | null;
  errorAfter: number | null;
} = { tokens: ["Hello ", "streaming ", "**world**."], delayMs: 2, gate: null, errorAfter: null };

export const chatRequests: ChatRequest[] = [];

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export const chatHandlers = [
  // POST /agenttrees/{tree}/chat (openapi.yaml:452-521): stream=true → SSE
  // frames task/token/done/error; stream=false → single JSON ChatResponse.
  // Omitting conversation_id starts a new conversation (openapi.yaml:488).
  http.post(`${BASE}/agenttrees/:tree/chat`, async ({ params, request }) => {
    captureLlmHeaders(request);
    const body = (await request.json()) as ChatRequest;
    chatRequests.push(body);
    const denied = enabledTreeGate(params.tree as string);
    if (denied) return denied;
    const isNew = !body.conversation_id;
    const convId = body.conversation_id ?? `c-new-${++counters.newConversation}`;
    const taskId = `task-${convId}`;
    if (isNew) {
      mockRoots.unshift(
        conv({
          id: convId,
          title: body.message.slice(0, 40),
          last_activity_at: new Date().toISOString(),
        }),
      );
    }
    const assistantTurn = (content: string): Turn => ({
      id: `t-a-${taskId}`,
      role: "assistant",
      author: "assistant",
      content,
      created_at: new Date().toISOString(),
      envelope,
    });

    if (body.stream === false) {
      const response: ChatResponse = {
        task_id: taskId,
        conversation_id: convId,
        turn: assistantTurn(chatConfig.tokens.join("")),
      };
      return HttpResponse.json(response);
    }

    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        const frame = (event: string, data: unknown) =>
          controller.enqueue(
            encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`),
          );
        frame("task", {
          task_id: taskId,
          conversation_id: convId,
          user_turn_id: `t-u-${taskId}`,
          assistant_turn_id: `t-a-${taskId}`,
        });
        let sent = "";
        let count = 0;
        for (const token of chatConfig.tokens) {
          await (chatConfig.gate?.() ?? sleep(chatConfig.delayMs));
          if (cancelledTasks.has(taskId)) {
            // done(cancelled) carries the persisted partial content
            // (openapi.yaml:1470).
            frame("done", { status: "cancelled", turn: assistantTurn(sent) });
            controller.close();
            return;
          }
          if (chatConfig.errorAfter !== null && count >= chatConfig.errorAfter) {
            // The SSE error frame IS the Error schema (openapi.yaml
            // x-sse-events), request_id included — a stream that dies
            // half-way is exactly when a user needs something to quote.
            frame("error", {
              code: "generation_failed",
              message: "model exploded",
              request_id: `req_msw${++counters.requestId}`,
            });
            controller.close();
            return;
          }
          sent += token;
          count++;
          frame("token", { delta: token });
        }
        await (chatConfig.gate?.() ?? sleep(chatConfig.delayMs));
        frame("done", {
          status: cancelledTasks.has(taskId) ? "cancelled" : "completed",
          turn: assistantTurn(sent),
        });
        controller.close();
      },
    });
    return new HttpResponse(stream, {
      headers: { "Content-Type": "text/event-stream" },
    });
  }),

  // POST /upload (openapi.yaml:523-554): multipart {file} → 201 Attachment
  // (url null in Phase 1); oversize → 413 Error, "the UI surfaces the message"
  // (openapi.yaml:535-536). Message mirrors mock/main.py:478-479.
  http.post(`${BASE}/upload`, async ({ request }) => {
    const form = await request.formData();
    const file = form.get("file");
    // No instanceof File: the parsed value is undici's File while the jsdom
    // test env's global File is jsdom's — different classes.
    if (!file || typeof file === "string") {
      return apiError("bad_request", "multipart field 'file' is required", 400);
    }
    uploadRequests.push({ filename: file.name, size: file.size });
    await uploadConfig.gate?.();
    if (file.size > uploadConfig.maxBytes) {
      return apiError("too_large", `File exceeds the ${Math.floor(uploadConfig.maxBytes / (1024 * 1024))} MB upload limit.`, 413);
    }
    const attachment: Attachment = {
      id: `att-${++counters.attachment}`,
      filename: file.name,
      content_type: file.type || "application/octet-stream",
      size: file.size,
      url: null,
    };
    return HttpResponse.json(attachment, { status: 201 });
  }),
];

export function resetChat() {
  uploadRequests.length = 0;
  uploadConfig.maxBytes = 5 * 1024 * 1024;
  uploadConfig.gate = null;
  chatRequests.length = 0;
  chatConfig.tokens = ["Hello ", "streaming ", "**world**."];
  chatConfig.delayMs = 2;
  chatConfig.gate = null;
  chatConfig.errorAfter = null;
}
