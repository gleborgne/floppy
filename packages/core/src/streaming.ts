import { T, TextError } from "./i18n.ts";
/** SSE JSON, y compris les événements et caractères UTF-8 répartis sur plusieurs blocs. */
export async function* readSse(body: ReadableStream<Uint8Array>): AsyncGenerator<unknown> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const parse = (block: string) => {
    const value = block.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trimStart()).join("\n");
    return !value || value === "[DONE]" ? undefined : JSON.parse(value);
  };
  try {
    for (;;) {
      const { value, done } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      buffer = buffer.replace(/\r\n/g, "\n");
      let pos: number;
      while ((pos = buffer.indexOf("\n\n")) >= 0) {
        const event = parse(buffer.slice(0, pos)); buffer = buffer.slice(pos + 2);
        if (event !== undefined) yield event;
      }
      if (buffer.length > 16 * 1024 * 1024) throw new TextError(T("Événement SSE trop volumineux", "SSE event too large"));
      if (done) { const event = parse(buffer); if (event !== undefined) yield event; break; }
    }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}
