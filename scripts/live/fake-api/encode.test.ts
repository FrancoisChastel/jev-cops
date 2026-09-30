import { describe, expect, test } from "bun:test";
import { anthropicResponse, countTokensResponse } from "./anthropic.ts";
import { chatResponse, modelsResponse, responsesResponse } from "./openai.ts";
import type { Reply } from "./plan.ts";
import { parseSse } from "./sse-parse.ts";

const call: Reply = {
  kind: "call",
  tool: "Bash",
  input: { command: "ls" },
  scenario: "ls",
  step: 0,
};
const words: Reply = {
  kind: "text",
  text: "hello",
  scenario: null,
  step: null,
  why: "no-scenario",
};

type Json = Record<string, unknown>;

describe("anthropicResponse", () => {
  test("JSON tool_use and text", async () => {
    const tool = (await anthropicResponse(call, {
      stream: false,
      model: "m",
      seq: 3,
    }).json()) as Json;
    expect(tool).toMatchObject({
      id: "msg_fake_3",
      model: "m",
      stop_reason: "tool_use",
      content: [{ type: "tool_use", id: "toolu_fake_3", name: "Bash", input: { command: "ls" } }],
    });
    const text = (await anthropicResponse(words, {
      stream: false,
      model: "m",
      seq: 4,
    }).json()) as Json;
    expect(text).toMatchObject({
      stop_reason: "end_turn",
      content: [{ type: "text", text: "hello" }],
    });
  });

  test("SSE: tool input arrives as one input_json_delta; text as one text_delta", async () => {
    const res = anthropicResponse(call, { stream: true, model: "m", seq: 1 });
    expect(res.headers.get("content-type")).toBe("text/event-stream");
    const events = parseSse(await res.text());
    expect(events.map(([e]) => e)).toEqual([
      "message_start",
      "content_block_start",
      "content_block_delta",
      "content_block_stop",
      "message_delta",
      "message_stop",
    ]);
    expect(events[1]?.[1]).toMatchObject({ content_block: { type: "tool_use", input: {} } });
    expect(events[2]?.[1]).toMatchObject({
      delta: { type: "input_json_delta", partial_json: '{"command":"ls"}' },
    });
    const text = parseSse(
      await anthropicResponse(words, { stream: true, model: "m", seq: 2 }).text(),
    );
    expect(text[2]?.[1]).toMatchObject({ delta: { type: "text_delta", text: "hello" } });
    expect(text[4]?.[1]).toMatchObject({ delta: { stop_reason: "end_turn" } });
  });

  test("count_tokens", async () => {
    expect(await countTokensResponse().json()).toEqual({ input_tokens: 10 });
  });
});

const opts = { model: "gpt", seq: 7, created: 1_700_000_000 };

describe("responsesResponse", () => {
  test("JSON function_call and message", async () => {
    const tool = (await responsesResponse(call, { ...opts, stream: false }).json()) as Json;
    expect(tool).toMatchObject({
      id: "resp_fake_7",
      status: "completed",
      output: [
        {
          type: "function_call",
          call_id: "call_fake_7",
          name: "Bash",
          arguments: '{"command":"ls"}',
        },
      ],
    });
    const text = (await responsesResponse(words, { ...opts, stream: false }).json()) as Json;
    expect(text).toMatchObject({
      output: [
        { type: "message", role: "assistant", content: [{ type: "output_text", text: "hello" }] },
      ],
    });
  });

  test("SSE: typed, numbered events ending in response.completed", async () => {
    const events = parseSse(await responsesResponse(call, { ...opts, stream: true }).text());
    expect(events.map(([e]) => e)).toEqual([
      "response.created",
      "response.in_progress",
      "response.output_item.added",
      "response.function_call_arguments.delta",
      "response.function_call_arguments.done",
      "response.output_item.done",
      "response.completed",
    ]);
    events.forEach(([e, d], n) => {
      expect(d).toMatchObject({ type: e, sequence_number: n });
    });
    expect(events[2]?.[1]).toMatchObject({ item: { type: "function_call", arguments: "" } });
    expect(events[5]?.[1]).toMatchObject({ item: { arguments: '{"command":"ls"}' } });
    const text = parseSse(await responsesResponse(words, { ...opts, stream: true }).text());
    expect(text.map(([e]) => e)).toContain("response.output_text.delta");
    expect(text[2]?.[1]).toMatchObject({ item: { type: "message", content: [] } });
  });
});

describe("chatResponse", () => {
  test("JSON tool_calls and text", async () => {
    const tool = (await chatResponse(call, {
      ...opts,
      stream: false,
      includeUsage: false,
    }).json()) as Json;
    expect(tool).toMatchObject({
      object: "chat.completion",
      choices: [
        {
          finish_reason: "tool_calls",
          message: {
            content: null,
            tool_calls: [
              { id: "call_fake_7", function: { name: "Bash", arguments: '{"command":"ls"}' } },
            ],
          },
        },
      ],
    });
    const text = (await chatResponse(words, {
      ...opts,
      stream: false,
      includeUsage: false,
    }).json()) as Json;
    expect(text).toMatchObject({
      choices: [{ finish_reason: "stop", message: { content: "hello" } }],
    });
  });

  test("SSE chunks, optional usage chunk, [DONE]", async () => {
    const withUsage = parseSse(
      await chatResponse(call, { ...opts, stream: true, includeUsage: true }).text(),
    );
    expect(withUsage).toHaveLength(5);
    expect(withUsage[1]?.[1]).toMatchObject({
      choices: [{ delta: { tool_calls: [{ index: 0 }] } }],
    });
    expect(withUsage[2]?.[1]).toMatchObject({ choices: [{ finish_reason: "tool_calls" }] });
    expect(withUsage[3]?.[1]).toMatchObject({ choices: [], usage: { total_tokens: 15 } });
    expect(withUsage[4]?.[1]).toBe("[DONE]");
    const plain = parseSse(
      await chatResponse(words, { ...opts, stream: true, includeUsage: false }).text(),
    );
    expect(plain).toHaveLength(4);
    expect(plain[1]?.[1]).toMatchObject({ choices: [{ delta: { content: "hello" } }] });
  });
});

test("modelsResponse lists the script's models", async () => {
  expect(await modelsResponse(["a"], 5).json()).toEqual({
    object: "list",
    data: [{ id: "a", object: "model", created: 5, owned_by: "jev-cops-fake" }],
  });
});
