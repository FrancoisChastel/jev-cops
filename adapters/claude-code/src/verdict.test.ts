import { describe, expect, test } from "bun:test";
import { parseJudged, parseView } from "./verdict.ts";

const ID = "evt_01M3PP723DWGXKY6ZN6TC6ZMXZ";

describe("parseJudged: the daemon's verdict, or null (the caller fails closed)", () => {
  test("keeps what the hook acts on", () => {
    const body = {
      schema: "jev-cops.verdict/1",
      event_id: ID,
      verdict: "annotate",
      reason: "r",
      context_note: "n",
      updated_input: null,
      risk: 0.3,
    };
    expect(parseJudged(body, ID)).toEqual({
      verdict: "annotate",
      reason: "r",
      note: "n",
      input: null,
    });
  });

  test("a rewrite carries its input", () => {
    const body = { event_id: ID, verdict: "rewrite", reason: "r", updated_input: { command: "x" } };
    expect(parseJudged(body, ID)).toEqual({
      verdict: "rewrite",
      reason: "r",
      note: null,
      input: { command: "x" },
    });
  });

  test("updated_input on another verdict is ignored", () => {
    const body = { event_id: ID, verdict: "allow", reason: "r", updated_input: { command: "x" } };
    expect(parseJudged(body, ID)?.input).toBeNull();
  });

  test.each([
    ["not an object", "allow"],
    ["another event's verdict", { event_id: "evt_other", verdict: "allow", reason: "r" }],
    ["an unknown verdict", { event_id: ID, verdict: "maybe", reason: "r" }],
    ["no reason", { event_id: ID, verdict: "deny" }],
    ["a rewrite without input", { event_id: ID, verdict: "rewrite", reason: "r" }],
    [
      "a rewrite with an array input",
      { event_id: ID, verdict: "rewrite", reason: "r", updated_input: [] },
    ],
    ["null", null],
  ] as const)("%s → null", (_name, body) => {
    expect(parseJudged(body, ID)).toBeNull();
  });
});

describe("parseView: the T8 confirm view", () => {
  test("raw, summary and event id; a scored detail, even if sent, is never read", () => {
    const scored = "verdict hold · risk 0.61 · floor 0.61\ntaint 0.87: from tool output: x";
    const body = { event_id: ID, verdict: "hold", reason: "r", raw: "ls", summary: "s" };
    expect(parseView({ ...body, detail: scored })).toEqual({
      raw: "ls",
      summary: "s",
      eventId: ID,
    });
  });

  test("a view without a summary keeps the raw command", () => {
    expect(parseView({ raw: "ls", detail: "d" })).toEqual({
      raw: "ls",
      summary: null,
      eventId: null,
    });
  });

  test.each([[null], [{}], [{ raw: 3 }], ["ls"]])("%p → null", (body) => {
    expect(parseView(body)).toBeNull();
  });
});
