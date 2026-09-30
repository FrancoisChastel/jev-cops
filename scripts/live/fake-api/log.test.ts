import { describe, expect, test } from "bun:test";
import { condenseBody, digest, headerFacts, replySummary } from "./log.ts";

describe("headerFacts", () => {
  test("auth headers become facts; the rest is kept", () => {
    const h = new Headers({
      "x-api-key": "dummy-key",
      authorization: "Bearer real-secret",
      "user-agent": "claude-cli/2",
      "anthropic-beta": "x",
    });
    const f = headerFacts(h, "dummy-key");
    expect(f.headers).toEqual({ "user-agent": "claude-cli/2", "anthropic-beta": "x" });
    expect(f.auth).toEqual({
      authorization: "other",
      "x-api-key": "dummy",
      "api-key": "absent",
      "proxy-authorization": "absent",
      cookie: "absent",
    });
    expect(JSON.stringify(f)).not.toContain("real-secret");
  });

  test("a bearer dummy is dummy; with no expected key anything present is other", () => {
    expect(headerFacts(new Headers({ authorization: "Bearer k" }), "k").auth.authorization).toBe(
      "dummy",
    );
    expect(headerFacts(new Headers({ authorization: "Bearer k" }), "").auth.authorization).toBe(
      "other",
    );
  });
});

describe("condenseBody", () => {
  test("anthropic: system and tools condensed, messages verbatim", () => {
    const messages = [{ role: "user", content: "hi" }];
    const out = condenseBody("anthropic", {
      system: [{ type: "text", text: "long" }],
      tools: [{ name: "Bash", input_schema: {} }],
      messages,
    }) as Record<string, unknown>;
    expect(out.tools).toEqual(["Bash"]);
    expect(out.system).toEqual(digest([{ type: "text", text: "long" }]));
    expect(out.messages).toBe(messages);
  });

  test("responses: instructions and tools (by name or type)", () => {
    const out = condenseBody("responses", {
      instructions: "sys",
      tools: [{ type: "function", name: "shell" }, { type: "web_search" }, 1, {}],
    }) as Record<string, unknown>;
    expect(out.instructions).toEqual({ chars: 3, sha256: digest("sys").sha256 });
    expect(out.tools).toEqual(["shell", "web_search", "?", "?"]);
  });

  test("chat: system and developer messages condensed; tool function names", () => {
    const out = condenseBody("chat", {
      tools: [{ type: "function", function: { name: "bash" } }],
      messages: [
        { role: "system", content: "sys" },
        { role: "developer", content: "dev" },
        { role: "user", content: "hi" },
        null,
      ],
    }) as Record<string, unknown>;
    expect(out.tools).toEqual(["bash"]);
    expect(out.messages).toEqual([
      { role: "system", content: digest("sys") },
      { role: "developer", content: digest("dev") },
      { role: "user", content: "hi" },
      null,
    ]);
    expect(condenseBody("chat", { messages: "x" })).toEqual({ messages: "x" });
  });

  test("non-object bodies and a non-array tools field pass through", () => {
    expect(condenseBody("other", "text")).toBe("text");
    expect(condenseBody("other", [1])).toEqual([1]);
    expect(condenseBody("other", { tools: "x" })).toEqual({ tools: [] });
  });

  test("digest of undefined", () => {
    expect(digest(undefined).chars).toBe(4);
  });
});

describe("replySummary", () => {
  test("call, text, none", () => {
    expect(
      replySummary({ kind: "call", tool: "Bash", input: { a: 1 }, scenario: "s", step: 0 }),
    ).toEqual({ kind: "call", scenario: "s", step: 0, tool: "Bash", input: { a: 1 } });
    expect(
      replySummary({ kind: "text", text: "t", scenario: null, step: null, why: "no-scenario" }),
    ).toEqual({ kind: "text", scenario: null, step: null, why: "no-scenario", text: "t" });
    expect(replySummary(null)).toBeNull();
  });
});
