/** Reading an SSE body back (tests, and the live scripts' assertions). */

type Json = Record<string, unknown>;

/** Parses an SSE body into [event, data] pairs (`data: [DONE]` kept as a string). */
export function parseSse(body: string): Array<[string | null, Json | string]> {
  return body
    .split("\n\n")
    .filter((chunk) => chunk.trim() !== "")
    .map((chunk) => {
      const lines = chunk.split("\n");
      const event = lines.find((l) => l.startsWith("event: "))?.slice(7) ?? null;
      const data = lines.find((l) => l.startsWith("data: "))?.slice(6) ?? "";
      return [event, data === "[DONE]" ? data : (JSON.parse(data) as Json)];
    });
}
