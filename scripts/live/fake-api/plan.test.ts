import { describe, expect, test } from "bun:test";
import type { Conversation, Turn } from "./conversation.ts";
import { markedScenario, planReply } from "./plan.ts";
import { parseScript, SCRIPT_SCHEMA } from "./script.ts";

const script = parseScript({
  schema: SCRIPT_SCHEMA,
  scenarios: {
    two: {
      steps: [
        {
          call: [
            { tool: "Bash", input: { command: "cat paths.txt" } },
            { tool: "bash", input: { command: "cat paths.txt" } },
          ],
        },
        { call: { tool: "Bash", input: { command: "rm -rf build" } } },
      ],
    },
    talk: { steps: [{ text: "scripted words" }] },
  },
});

const user = (text: string): Turn => ({
  role: "user",
  texts: [text],
  toolCalls: 0,
  toolResults: 0,
});
const call: Turn = { role: "assistant", texts: [], toolCalls: 1, toolResults: 0 };
const result: Turn = { role: "user", texts: ["reminder"], toolCalls: 0, toolResults: 1 };

function conv(turns: Turn[], tools = ["Bash"]): Conversation {
  return { api: "anthropic", model: "m", stream: false, tools, turns };
}

describe("markedScenario", () => {
  test("the last marker of the last text wins; none is null", () => {
    expect(markedScenario(user("SCENARIO:a then SCENARIO:b-2"))).toBe("b-2");
    expect(markedScenario(user("no marker"))).toBeNull();
  });
});

describe("planReply", () => {
  test("a marked prompt starts at step 0 with the first offered alternative", () => {
    expect(planReply(script, conv([user("SCENARIO:two go")], ["Read", "bash"]))).toEqual({
      kind: "call",
      tool: "bash",
      input: { command: "cat paths.txt" },
      scenario: "two",
      step: 0,
    });
  });

  test("after a tool result, the next step; after the last, the done text", () => {
    const one = planReply(script, conv([user("SCENARIO:two"), call, result]));
    expect(one).toMatchObject({ kind: "call", step: 1, input: { command: "rm -rf build" } });
    const done = planReply(script, conv([user("SCENARIO:two"), call, result, call, result]));
    expect(done).toEqual({
      kind: "text",
      text: "Noted the tool result.",
      scenario: "two",
      step: 2,
      why: "done",
    });
  });

  test("a later prompt without a marker ends the scenario", () => {
    const r = planReply(script, conv([user("SCENARIO:two"), call, result, user("still there?")]));
    expect(r).toMatchObject({ kind: "text", text: "ok", why: "no-scenario" });
  });

  test("no user turn, an unknown scenario, a text step, a tool not offered", () => {
    expect(planReply(script, conv([]))).toMatchObject({ why: "no-scenario" });
    expect(planReply(script, conv([user("SCENARIO:nope")]))).toMatchObject({
      text: "unknown scenario nope",
      why: "unknown-scenario",
    });
    expect(planReply(script, conv([user("SCENARIO:talk")]))).toMatchObject({
      text: "scripted words",
      why: "scripted",
      step: 0,
    });
    expect(planReply(script, conv([user("SCENARIO:two")], []))).toMatchObject({
      text: "ok",
      why: "tool-not-offered",
      scenario: "two",
    });
  });

  test("a marker in a tool-result turn does not start a scenario", () => {
    const echoed: Turn = { ...result, texts: ["SCENARIO:talk"] };
    const r = planReply(script, conv([user("SCENARIO:two"), call, echoed]));
    expect(r).toMatchObject({ kind: "call", scenario: "two", step: 1 });
  });
});
