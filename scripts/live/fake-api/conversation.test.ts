import { describe, expect, test } from "bun:test";
import { fromAnthropic, fromChat, fromResponses } from "./conversation.ts";

describe("fromAnthropic", () => {
  test("tools, roles, texts, tool calls and results", () => {
    const c = fromAnthropic({
      model: "claude-x",
      stream: true,
      tools: [{ name: "Bash" }, { name: "Write" }, {}],
      messages: [
        { role: "user", content: "SCENARIO:ls go" },
        { role: "assistant", content: [{ type: "tool_use", id: "t", name: "Bash", input: {} }] },
        {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "t", content: "x" },
            { type: "text", text: "<system-reminder>r</system-reminder>" },
          ],
        },
        { role: "system", content: [{ type: "image" }] },
        "junk",
      ],
    });
    expect(c.api).toBe("anthropic");
    expect(c.model).toBe("claude-x");
    expect(c.stream).toBe(true);
    expect(c.tools).toEqual(["Bash", "Write"]);
    expect(c.turns).toEqual([
      { role: "user", texts: ["SCENARIO:ls go"], toolCalls: 0, toolResults: 0 },
      { role: "assistant", texts: [], toolCalls: 1, toolResults: 0 },
      {
        role: "user",
        texts: ["<system-reminder>r</system-reminder>"],
        toolCalls: 0,
        toolResults: 1,
      },
      { role: "other", texts: [], toolCalls: 0, toolResults: 0 },
      { role: "other", texts: [], toolCalls: 0, toolResults: 0 },
    ]);
  });

  test("defaults: no model, not streaming, no tools", () => {
    const c = fromAnthropic({});
    expect([c.model, c.stream, c.tools, c.turns]).toEqual(["fake-model", false, [], []]);
  });
});

describe("fromResponses", () => {
  test("string input is one user prompt", () => {
    const c = fromResponses({ model: "gpt", input: "SCENARIO:ls hi" });
    expect(c.turns).toEqual([
      { role: "user", texts: ["SCENARIO:ls hi"], toolCalls: 0, toolResults: 0 },
    ]);
  });

  test("items: messages, calls and outputs merge per turn; tools by name or type", () => {
    const c = fromResponses({
      stream: true,
      tools: [{ type: "function", name: "shell" }, { type: "web_search" }, 3],
      input: [
        { type: "message", role: "developer", content: [{ type: "input_text", text: "sys" }] },
        { role: "user", content: [{ type: "input_text", text: "SCENARIO:ls" }] },
        { type: "reasoning", summary: [] },
        { type: "function_call", name: "shell", arguments: "{}", call_id: "a" },
        { type: "custom_tool_call", name: "apply_patch", input: "", call_id: "b" },
        { type: "function_call_output", call_id: "a", output: "x" },
        { type: "custom_tool_call_output", call_id: "b", output: "y" },
        { type: "message", role: "assistant", content: [{ type: "output_text", text: "done" }] },
        null,
      ],
    });
    expect(c.tools).toEqual(["shell", "web_search"]);
    expect(c.turns).toEqual([
      { role: "other", texts: ["sys"], toolCalls: 0, toolResults: 0 },
      { role: "user", texts: ["SCENARIO:ls"], toolCalls: 0, toolResults: 0 },
      { role: "assistant", texts: [], toolCalls: 2, toolResults: 0 },
      { role: "user", texts: [], toolCalls: 0, toolResults: 2 },
      { role: "assistant", texts: ["done"], toolCalls: 0, toolResults: 0 },
    ]);
  });
});

describe("fromChat", () => {
  test("system, user parts, assistant tool calls and tool messages", () => {
    const c = fromChat({
      model: "m",
      tools: [{ type: "function", function: { name: "bash" } }, { type: "function" }],
      messages: [
        { role: "system", content: "sys" },
        { role: "user", content: [{ type: "text", text: "SCENARIO:ls" }, { type: "image_url" }] },
        { role: "assistant", content: null, tool_calls: [{ id: "a" }] },
        { role: "tool", tool_call_id: "a", content: "out" },
        { role: "tool", tool_call_id: "b", content: "out" },
        { role: "assistant", content: "fin" },
      ],
    });
    expect(c.tools).toEqual(["bash"]);
    expect(c.turns).toEqual([
      { role: "other", texts: ["sys"], toolCalls: 0, toolResults: 0 },
      { role: "user", texts: ["SCENARIO:ls"], toolCalls: 0, toolResults: 0 },
      { role: "assistant", texts: [], toolCalls: 1, toolResults: 0 },
      { role: "user", texts: [], toolCalls: 0, toolResults: 2 },
      { role: "assistant", texts: ["fin"], toolCalls: 0, toolResults: 0 },
    ]);
  });
});
