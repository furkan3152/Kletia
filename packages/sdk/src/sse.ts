export interface ServerSentEvent {
  readonly id?: string;
  readonly event?: string;
  readonly data: string;
}

/** Incremental `text/event-stream` parser over a fetch body. */
export async function* readServerSentEvents(
  body: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
): AsyncGenerator<ServerSentEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let id: string | undefined;
  let event: string | undefined;
  let data: string[] = [];
  // A chunk that ended in "\r" may be the first half of a CRLF; a "\n" that
  // opens the next chunk then belongs to that line ending, not an empty line.
  let pendingCr = false;
  const onAbort = () => {
    void reader.cancel().catch(() => undefined);
  };
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      if (pendingCr && buffer.length > 0) {
        if (buffer.startsWith("\n")) buffer = buffer.slice(1);
        pendingCr = false;
      }
      let newline = buffer.search(/\r\n|\r|\n/u);
      while (newline !== -1) {
        const line = buffer.slice(0, newline);
        const separatorLength = buffer.startsWith("\r\n", newline) ? 2 : 1;
        pendingCr = separatorLength === 1 && buffer[newline] === "\r" && newline + 1 === buffer.length;
        buffer = buffer.slice(newline + separatorLength);
        if (line === "") {
          if (data.length > 0) {
            yield { ...(id !== undefined ? { id } : {}), ...(event !== undefined ? { event } : {}), data: data.join("\n") };
          }
          event = undefined;
          data = [];
        } else if (!line.startsWith(":")) {
          const colon = line.indexOf(":");
          const field = colon === -1 ? line : line.slice(0, colon);
          const raw = colon === -1 ? "" : line.slice(colon + 1);
          const content = raw.startsWith(" ") ? raw.slice(1) : raw;
          if (field === "data") data.push(content);
          else if (field === "event") event = content;
          else if (field === "id" && !content.includes("\0")) id = content;
        }
        newline = buffer.search(/\r\n|\r|\n/u);
      }
      if (buffer.length > 1_000_000) throw new Error("Event stream frame exceeded 1 MB.");
    }
  } finally {
    signal?.removeEventListener("abort", onAbort);
    reader.releaseLock();
  }
}
