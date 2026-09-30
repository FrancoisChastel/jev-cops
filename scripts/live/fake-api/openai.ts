/**
 * A planned reply as an OpenAI Responses API response (Codex, OpenCode's `openai`
 * provider) or an OpenAI-compatible chat completion (Pi's `openai-completions`, OpenCode's
 * `openai-compatible`): JSON, or the SSE stream each client reads.
 */
import { sse } from "./anthropic.ts";
import type { Reply } from "./plan.ts";

type Json = Record<string, unknown>;

interface Opts {
  readonly stream: boolean;
  readonly model: string;
  readonly seq: number;
  /** Seconds since the epoch, for `created` fields. */
  readonly created: number;
}

const SSE_HEADERS = { "content-type": "text/event-stream", "cache-control": "no-cache" };

/** The Responses API output item for a reply (status as given). */
function responsesItem(reply: Reply, seq: number, status: string): Json {
  if (reply.kind === "call") {
    return {
      type: "function_call",
      id: `fc_fake_${seq}`,
      call_id: `call_fake_${seq}`,
      name: reply.tool,
      arguments: JSON.stringify(reply.input),
      status,
    };
  }
  const content =
    status === "completed" ? [{ type: "output_text", text: reply.text, annotations: [] }] : [];
  return { type: "message", id: `msg_fake_${seq}`, status, role: "assistant", content };
}

function responseObject(opts: Opts, status: string, output: Json[]): Json {
  return {
    id: `resp_fake_${opts.seq}`,
    object: "response",
    created_at: opts.created,
    status,
    model: opts.model,
    output,
    usage: {
      input_tokens: 10,
      input_tokens_details: { cached_tokens: 0 },
      output_tokens: 5,
      output_tokens_details: { reasoning_tokens: 0 },
      total_tokens: 15,
    },
  };
}

/** The item-specific events between `output_item.added` and `output_item.done`. */
function itemEvents(reply: Reply, item: Json): Array<readonly [string, Json]> {
  const ids = { item_id: item.id, output_index: 0 };
  if (reply.kind === "call") {
    const args = item.arguments;
    return [
      ["response.function_call_arguments.delta", { ...ids, delta: args }],
      ["response.function_call_arguments.done", { ...ids, arguments: args }],
    ];
  }
  const part = { type: "output_text", text: "", annotations: [] };
  const at = { ...ids, content_index: 0 };
  return [
    ["response.content_part.added", { ...at, part }],
    ["response.output_text.delta", { ...at, delta: reply.text }],
    ["response.output_text.done", { ...at, text: reply.text }],
    ["response.content_part.done", { ...at, part: { ...part, text: reply.text } }],
  ];
}

/** `POST /v1/responses`. */
export function responsesResponse(reply: Reply, opts: Opts): Response {
  const done = responsesItem(reply, opts.seq, "completed");
  const final = responseObject(opts, "completed", [done]);
  if (!opts.stream) return Response.json(final);
  const started = responsesItem(reply, opts.seq, "in_progress");
  const added = reply.kind === "call" ? { ...started, arguments: "" } : started;
  const events: Array<readonly [string, Json]> = [
    ["response.created", { response: responseObject(opts, "in_progress", []) }],
    ["response.in_progress", { response: responseObject(opts, "in_progress", []) }],
    ["response.output_item.added", { output_index: 0, item: added }],
    ...itemEvents(reply, done),
    ["response.output_item.done", { output_index: 0, item: done }],
    ["response.completed", { response: final }],
  ];
  const typed = events.map(
    ([type, data], n) => [type, { type, sequence_number: n, ...data }] as const,
  );
  return new Response(sse(typed), { headers: SSE_HEADERS });
}

function chatToolCall(reply: Extract<Reply, { kind: "call" }>, seq: number): Json {
  return {
    index: 0,
    id: `call_fake_${seq}`,
    type: "function",
    function: { name: reply.tool, arguments: JSON.stringify(reply.input) },
  };
}

const CHAT_USAGE = { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 };

function chunk(opts: Opts, choices: Json[], extra: Json = {}): string {
  const body = {
    id: `chatcmpl-fake-${opts.seq}`,
    object: "chat.completion.chunk",
    created: opts.created,
    model: opts.model,
    choices,
    ...extra,
  };
  return `data: ${JSON.stringify(body)}\n\n`;
}

/** `POST /v1/chat/completions`; `includeUsage` mirrors `stream_options.include_usage`. */
export function chatResponse(reply: Reply, opts: Opts & { readonly includeUsage: boolean }) {
  const finish = reply.kind === "call" ? "tool_calls" : "stop";
  const toolCalls = reply.kind === "call" ? [chatToolCall(reply, opts.seq)] : undefined;
  const content = reply.kind === "text" ? reply.text : null;
  if (!opts.stream) {
    const message = { role: "assistant", content, ...(toolCalls ? { tool_calls: toolCalls } : {}) };
    return Response.json({
      id: `chatcmpl-fake-${opts.seq}`,
      object: "chat.completion",
      created: opts.created,
      model: opts.model,
      choices: [{ index: 0, message, finish_reason: finish }],
      usage: CHAT_USAGE,
    });
  }
  const delta = toolCalls ? { tool_calls: toolCalls } : { content };
  const body = [
    chunk(opts, [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }]),
    chunk(opts, [{ index: 0, delta, finish_reason: null }]),
    chunk(opts, [{ index: 0, delta: {}, finish_reason: finish }]),
    opts.includeUsage ? chunk(opts, [], { usage: CHAT_USAGE }) : "",
    "data: [DONE]\n\n",
  ].join("");
  return new Response(body, { headers: SSE_HEADERS });
}

/** `GET /v1/models`: the script's models (OpenAI list shape). */
export function modelsResponse(models: readonly string[], created: number): Response {
  const data = models.map((id) => ({ id, object: "model", created, owned_by: "jev-cops-fake" }));
  return Response.json({ object: "list", data });
}
