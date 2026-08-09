// Minimal SSE frame parser for POST-based streams — EventSource can't POST,
// so POST /agenttrees/{tree}/chat is read off a fetch() ReadableStream
// (openapi.yaml:466-476: "stream=true → 200 text/event-stream with events:
// task/token/done/error"). Reused by the task queue stream.
//
// Implements the SSE wire format subset the contract uses:
// - frames are `event:` + `data:` lines terminated by a blank line
// - multiple data lines join with \n; a single leading space after ":" strips
// - lines starting with ":" are comments/keepalives — ignored
// - \n, \r\n and lone \r all terminate lines

export interface SseMessage {
  /** Event name; "message" when the frame carried no event: field (SSE default). */
  event: string;
  /** Data lines joined with newlines. */
  data: string;
}

export interface SseParser {
  /** Feed a decoded chunk; returns the frames completed by it. */
  push(chunk: string): SseMessage[];
  /** Signal end of stream; flushes a final unterminated frame if any. */
  end(): SseMessage[];
}

export function createSseParser(): SseParser {
  let buffer = "";
  let eventName = "";
  let dataLines: string[] = [];

  function dispatch(): SseMessage | null {
    if (dataLines.length === 0) {
      eventName = "";
      return null; // frame without data dispatches nothing (SSE spec)
    }
    const msg: SseMessage = {
      event: eventName || "message",
      data: dataLines.join("\n"),
    };
    eventName = "";
    dataLines = [];
    return msg;
  }

  function handleLine(line: string): SseMessage | null {
    if (line === "") return dispatch();
    if (line.startsWith(":")) return null; // comment / keepalive
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "event") eventName = value;
    else if (field === "data") dataLines.push(value);
    // id/retry fields: unused by the contract — ignored
    return null;
  }

  return {
    push(chunk: string): SseMessage[] {
      buffer += chunk;
      const out: SseMessage[] = [];
      let start = 0;
      for (let i = 0; i < buffer.length; i++) {
        const ch = buffer[i];
        if (ch !== "\n" && ch !== "\r") continue;
        // A trailing \r may be half of a \r\n split across chunks — wait.
        if (ch === "\r" && i === buffer.length - 1) break;
        const line = buffer.slice(start, i);
        if (ch === "\r" && buffer[i + 1] === "\n") i++;
        start = i + 1;
        const msg = handleLine(line);
        if (msg) out.push(msg);
      }
      buffer = buffer.slice(start);
      return out;
    },

    end(): SseMessage[] {
      const out: SseMessage[] = [];
      if (buffer !== "") {
        // Strip a dangling \r kept back by push(), then treat the remainder
        // as a final line.
        const line = buffer.endsWith("\r") ? buffer.slice(0, -1) : buffer;
        buffer = "";
        const msg = handleLine(line);
        if (msg) out.push(msg);
      }
      // Pragmatic deviation from the SSE spec (which discards incomplete
      // frames at EOF): servers that close right after the last data line
      // still get their terminal frame delivered.
      const last = dispatch();
      if (last) out.push(last);
      return out;
    },
  };
}

/** Parse a fetch() SSE response body into frames as they arrive. */
export async function* parseSseStream(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<SseMessage, void> {
  const parser = createSseParser();
  const reader = body.getReader();
  const decoder = new TextDecoder();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      yield* parser.push(decoder.decode(value, { stream: true }));
    }
    yield* parser.end();
  } finally {
    reader.releaseLock();
  }
}
