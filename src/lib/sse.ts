/**
 * Minimal SSE reader for `fetch` responses.
 *
 * EventSource cannot issue a POST, and the analysis request carries a body, so
 * the stream is parsed by hand. Only the `data:` field is used — this endpoint
 * does not send event names or ids.
 */
export async function* readSseStream<T>(
  response: Response,
  signal?: AbortSignal,
): AsyncGenerator<T, void, undefined> {
  if (!response.body) throw new Error("The server returned no stream.");

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      if (signal?.aborted) return;

      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      // Frames are separated by a blank line. Keep the trailing partial frame
      // in the buffer until its terminator arrives.
      let separator = buffer.indexOf("\n\n");
      while (separator !== -1) {
        const frame = buffer.slice(0, separator);
        buffer = buffer.slice(separator + 2);

        const data = frame
          .split("\n")
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trimStart())
          .join("\n");

        if (data) {
          try {
            yield JSON.parse(data) as T;
          } catch {
            // A malformed frame should not kill an in-flight analysis.
          }
        }

        separator = buffer.indexOf("\n\n");
      }
    }
  } finally {
    reader.releaseLock();
  }
}
