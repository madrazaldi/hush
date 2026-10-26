// Minimal, tolerant Server-Sent Events parser over a fetch body stream.

export interface SseEvent {
  event: string | null;
  data: string;
}

/**
 * Incremental parser. Bytes are buffered until a full line arrives, so multi-byte UTF-8 characters
 * split across network chunks decode intact.
 */
export class SseParser {
  private buf: Uint8Array = new Uint8Array(0);
  private event: string | null = null;
  private data: string[] = [];
  private dec = new TextDecoder();

  feed(bytes: Uint8Array, out: SseEvent[]): void {
    const joined = new Uint8Array(this.buf.length + bytes.length);
    joined.set(this.buf);
    joined.set(bytes, this.buf.length);
    let start = 0;
    for (;;) {
      const nl = joined.indexOf(0x0a, start);
      if (nl < 0) break;
      this.line(this.dec.decode(joined.subarray(start, nl)).replace(/\r+$/, ""), out);
      start = nl + 1;
    }
    this.buf = joined.slice(start);
  }

  private line(line: string, out: SseEvent[]): void {
    if (line === "") {
      if (this.data.length > 0 || this.event !== null) {
        out.push({ event: this.event, data: this.data.join("\n") });
        this.event = null;
        this.data = [];
      }
      return;
    }
    if (line.startsWith(":")) return;
    const i = line.indexOf(":");
    let field = line;
    let value = "";
    if (i >= 0) {
      field = line.slice(0, i);
      value = line.slice(i + 1);
      if (value.startsWith(" ")) value = value.slice(1);
    }
    if (field === "event") this.event = value;
    else if (field === "data") this.data.push(value);
  }

  finish(out: SseEvent[]): void {
    if (this.buf.length > 0) {
      const rest = this.dec.decode(this.buf).replace(/\r+$/, "");
      this.buf = new Uint8Array(0);
      this.line(rest, out);
    }
    if (this.data.length > 0) {
      out.push({ event: this.event, data: this.data.join("\n") });
      this.event = null;
      this.data = [];
    }
  }
}

/** Calls `onEvent` for each complete SSE event. Return `false` to stop early. */
export async function forEachEvent(resp: Response, onEvent: (ev: SseEvent) => boolean): Promise<void> {
  if (!resp.body) return;
  const reader = resp.body.getReader();
  const parser = new SseParser();
  const events: SseEvent[] = [];
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      parser.feed(value, events);
      for (const ev of events.splice(0)) if (!onEvent(ev)) return;
    }
    parser.finish(events);
    for (const ev of events) if (!onEvent(ev)) break;
  } finally {
    reader.cancel().catch(() => {});
  }
}
