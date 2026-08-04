import { describe, expect, it } from "vitest";
import { createSseParser, parseSseStream, type SseMessage } from "./sse";

// Frame fixtures per the chat contract (openapi.yaml:466-476): events
// task/token/done/error with `event:` + `data:` lines, blank-line terminated.

describe("createSseParser", () => {
  it("parses a single event/data frame", () => {
    const p = createSseParser();
    const out = p.push('event: token\ndata: {"delta":"Hi"}\n\n');
    expect(out).toEqual([{ event: "token", data: '{"delta":"Hi"}' }]);
  });

  it("parses multiple frames arriving in one chunk", () => {
    const p = createSseParser();
    const out = p.push(
      'event: task\ndata: {"task_id":"t1"}\n\nevent: token\ndata: {"delta":"a"}\n\n',
    );
    expect(out.map((m) => m.event)).toEqual(["task", "token"]);
  });

  it("handles frames split across chunk boundaries (mid-line and mid-frame)", () => {
    const p = createSseParser();
    const out: SseMessage[] = [];
    // split mid-field-name, mid-value, and between data and blank line
    for (const chunk of ["eve", "nt: tok", "en\ndata: {\"del", 'ta":"ab"}', "\n", "\n"]) {
      out.push(...p.push(chunk));
    }
    expect(out).toEqual([{ event: "token", data: '{"delta":"ab"}' }]);
  });

  it("ignores comment/keepalive lines and unknown fields", () => {
    const p = createSseParser();
    const out = p.push(': keepalive\n\nid: 7\nretry: 100\nevent: done\ndata: {}\n\n');
    expect(out).toEqual([{ event: "done", data: "{}" }]);
  });

  it("joins multiple data lines with newlines", () => {
    const p = createSseParser();
    const out = p.push("data: line1\ndata: line2\n\n");
    expect(out).toEqual([{ event: "message", data: "line1\nline2" }]);
  });

  it("defaults the event name to 'message' when no event field is present", () => {
    const p = createSseParser();
    expect(p.push("data: x\n\n")[0].event).toBe("message");
  });

  it("handles CRLF line endings, including a \\r\\n split across chunks", () => {
    const p = createSseParser();
    const out: SseMessage[] = [];
    out.push(...p.push("event: token\r"));
    out.push(...p.push('\ndata: {"delta":"z"}\r\n\r\n'));
    expect(out).toEqual([{ event: "token", data: '{"delta":"z"}' }]);
  });

  it("dispatches a frame without data as nothing", () => {
    const p = createSseParser();
    expect(p.push("event: ping\n\n")).toEqual([]);
  });

  it("end() flushes a final frame missing its trailing blank line", () => {
    const p = createSseParser();
    expect(p.push('event: done\ndata: {"status":"completed"}\n')).toEqual([]);
    expect(p.end()).toEqual([{ event: "done", data: '{"status":"completed"}' }]);
  });
});

describe("parseSseStream", () => {
  it("yields all four chat event types from a ReadableStream in order", async () => {
    const encoder = new TextEncoder();
    const frames = [
      'event: task\ndata: {"task_id":"t1","conversation_id":"c1","user_turn_id":"u1","assistant_turn_id":"a1"}\n\n',
      ': keepalive\n\n',
      'event: token\ndata: {"delta":"Hel"}\n\nevent: token\ndata: {"delta":"lo"}\n\n',
      'event: error\ndata: {"code":"x","message":"boom"}\n\n',
      'event: done\ndata: {"status":"completed","turn":{"id":"a1"}}\n\n',
    ];
    // enqueue in uneven chunks to cross frame boundaries
    const raw = frames.join("");
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let i = 0; i < raw.length; i += 17) {
          controller.enqueue(encoder.encode(raw.slice(i, i + 17)));
        }
        controller.close();
      },
    });
    const got: SseMessage[] = [];
    for await (const msg of parseSseStream(stream)) got.push(msg);
    expect(got.map((m) => m.event)).toEqual(["task", "token", "token", "error", "done"]);
    expect(JSON.parse(got[0].data).task_id).toBe("t1");
    expect(JSON.parse(got[4].data).status).toBe("completed");
  });
});
