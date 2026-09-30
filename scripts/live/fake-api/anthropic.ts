/**
 * A planned reply as an Anthropic Messages API response: JSON, or the SSE stream Claude
 * Code reads (`message_start`, one content block with its deltas, `message_delta`,
 * `message_stop`). The shape the M1 capture proved against Claude Code 2.1.280.
 */
import type { Reply } from "./plan.ts";

type Block = Record<string, unknown>;

/** Server-sent events: `event: <name>` and one JSON `data` line each. */
export function sse(events: ReadonlyArray<readonly [string, unknown]>): string {
  return events.map(([e, d]) => `event: ${e}\ndata: ${JSON.stringify(d)}\n\n`).join("");
}

const USAGE = { input_tokens: 10, output_tokens: 5 } as const;

function block(reply: Reply, seq: number): Block {
  if (reply.kind === "text") return { type: "text", text: reply.text };
  return { type: "tool_use", id: `toolu_fake_${seq}`, name: reply.tool, input: reply.input };
}

function streamEvents(b: Block, base: Block, stop: string): Array<readonly [string, unknown]> {
  const start = { ...base, content: [], stop_reason: null, usage: USAGE };
  const isTool = b.type === "tool_use";
  const empty = isTool ? { ...b, input: {} } : { type: "text", text: "" };
  const delta = isTool
    ? { type: "input_json_delta", partial_json: JSON.stringify(b.input) }
    : { type: "text_delta", text: b.text };
  return [
    ["message_start", { type: "message_start", message: start }],
    ["content_block_start", { type: "content_block_start", index: 0, content_block: empty }],
    ["content_block_delta", { type: "content_block_delta", index: 0, delta }],
    ["content_block_stop", { type: "content_block_stop", index: 0 }],
    [
      "message_delta",
      { type: "message_delta", delta: { stop_reason: stop, stop_sequence: null }, usage: USAGE },
    ],
    ["message_stop", { type: "message_stop" }],
  ];
}

/** The HTTP response for `reply` to request number `seq`. */
export function anthropicResponse(
  reply: Reply,
  opts: { readonly stream: boolean; readonly model: string; readonly seq: number },
): Response {
  const b = block(reply, opts.seq);
  const stop = reply.kind === "call" ? "tool_use" : "end_turn";
  const base = {
    id: `msg_fake_${opts.seq}`,
    type: "message",
    role: "assistant",
    model: opts.model,
    stop_sequence: null,
  };
  if (!opts.stream) {
    return Response.json({ ...base, content: [b], stop_reason: stop, usage: USAGE });
  }
  return new Response(sse(streamEvents(b, base, stop)), {
    headers: { "content-type": "text/event-stream", "cache-control": "no-cache" },
  });
}

/** `POST /v1/messages/count_tokens`. */
export function countTokensResponse(): Response {
  return Response.json({ input_tokens: USAGE.input_tokens });
}
