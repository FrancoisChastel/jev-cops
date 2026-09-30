import { describe, expect, test } from "bun:test";
import { EVENT_FIXTURES, loadEventFixture } from "../../../../tests/fixtures/events/index.ts";
import type { SchemaError } from "./errors.ts";
import { type Event, parseEvent } from "./event.ts";

type Json = Record<string, unknown>;

function fixture(name: (typeof EVENT_FIXTURES)[number]): Json {
  return loadEventFixture(name) as Json;
}

function omit(source: Json, key: string): Json {
  return Object.fromEntries(Object.entries(source).filter(([k]) => k !== key));
}

function patch(source: Json, section: string, changes: Json): Json {
  return { ...source, [section]: { ...(source[section] as Json), ...changes } };
}

function omitIn(source: Json, section: string, key: string): Json {
  return { ...source, [section]: omit(source[section] as Json, key) };
}

function expectValid(input: unknown): Event {
  const result = parseEvent(input);
  if (!result.ok) throw new Error(`expected a valid event, got: ${result.error.message}`);
  return result.value;
}

function expectInvalid(input: unknown): SchemaError {
  const result = parseEvent(input);
  if (result.ok) throw new Error("expected the event to be rejected");
  return result.error;
}

function paths(error: SchemaError): string[] {
  return error.issues.map((issue) => issue.path);
}

const MINIMAL_PRE: Json = {
  schema: "jev-cops.event/1",
  id: "evt_01M3PP723DWGXKY6ZN6TC6ZMXZ",
  phase: "pre",
  harness: "pi",
  session: { id: "sess_1" },
  call: { id: "call_1", tool: "Bash", kind: "exec", input: { command: "ls" }, cwd: "/work/repo" },
};

describe("parseEvent: accepts", () => {
  test("a valid pre event", () => {
    const event = expectValid(fixture("pre-bash"));
    expect(event.phase).toBe("pre");
    expect(event.call.input).toEqual({
      command: "rm -rf node_modules",
      description: "Remove installed dependencies",
    });
  });

  test("a valid post event and exposes its result", () => {
    const event = expectValid(fixture("post-bash"));
    expect(event.phase).toBe("post");
    if (event.phase !== "post") throw new Error("unreachable");
    expect(event.result.exit_code).toBe(0);
  });

  test.each([...EVENT_FIXTURES])("the canonical fixture %s", (name) => {
    expect(parseEvent(fixture(name)).ok).toBe(true);
  });

  test("an event carrying only the required fields", () => {
    expect(parseEvent(MINIMAL_PRE).ok).toBe(true);
  });

  test.each(["mcp:github:create_issue", "Task", "SomeFutureTool"])(
    "the unknown call.tool string %p",
    (tool) => {
      expect(parseEvent(patch(MINIMAL_PRE, "call", { tool })).ok).toBe(true);
    },
  );

  test("a subagent session whose parent_id is a session id", () => {
    const event = expectValid(patch(MINIMAL_PRE, "session", { parent_id: "sess_parent" }));
    expect(event.session.parent_id).toBe("sess_parent");
  });
});

describe("parseEvent: defaults", () => {
  test("session.parent_id to null when absent", () => {
    const event = expectValid(MINIMAL_PRE);
    expect(event.session.parent_id).toBeNull();
  });
});

describe("parseEvent: rejects missing required fields with their dotted path", () => {
  test.each(["schema", "id", "phase", "harness", "session", "call"])("top-level %s", (key) => {
    expect(paths(expectInvalid(omit(fixture("pre-bash"), key)))).toContain(key);
  });

  test("session.id", () => {
    const error = expectInvalid(omitIn(fixture("pre-bash"), "session", "id"));
    expect(paths(error)).toEqual(["session.id"]);
  });

  test.each(["id", "tool", "kind", "input", "cwd"])("call.%s", (key) => {
    const error = expectInvalid(omitIn(fixture("pre-bash"), "call", key));
    expect(paths(error)).toEqual([`call.${key}`]);
  });

  test("several nested fields at once, each with its own path", () => {
    const input = omitIn(omitIn(fixture("pre-bash"), "call", "cwd"), "session", "id");
    expect(paths(expectInvalid(input)).sort()).toEqual(["call.cwd", "session.id"]);
  });

  test("actor.kind when an actor is present", () => {
    const input = { ...fixture("pre-bash"), actor: { model: "claude-opus-4-6" } };
    expect(paths(expectInvalid(input))).toEqual(["actor.kind"]);
  });
});

describe("parseEvent: rejects malformed values", () => {
  test("an unknown schema version", () => {
    const error = expectInvalid({ ...fixture("pre-bash"), schema: "jev-cops.event/2" });
    expect(paths(error)).toEqual(["schema"]);
  });

  test.each(["evt_01J9…", "evt_01M3PP723DWGXKY6ZN6TC6ZMX", "01M3PP723DWGXKY6ZN6TC6ZMXZ"])(
    "the malformed event id %p",
    (id) => {
      expect(paths(expectInvalid({ ...fixture("pre-bash"), id }))).toEqual(["id"]);
    },
  );

  test("a session id without the sess_ prefix", () => {
    const error = expectInvalid(patch(MINIMAL_PRE, "session", { id: "01M3PP6ZQ4" }));
    expect(paths(error)).toEqual(["session.id"]);
  });

  test("a call id without the call_ prefix", () => {
    const error = expectInvalid(patch(MINIMAL_PRE, "call", { id: "toolu_01A9" }));
    expect(paths(error)).toEqual(["call.id"]);
  });

  test("a parent_id that is not a session id", () => {
    const error = expectInvalid(patch(MINIMAL_PRE, "session", { parent_id: "call_1" }));
    expect(paths(error)).toEqual(["session.parent_id"]);
  });

  test.each([
    ["phase", (e: Json) => ({ ...e, phase: "during" })],
    ["harness", (e: Json) => ({ ...e, harness: "cursor" })],
    ["call.kind", (e: Json) => patch(e, "call", { kind: "fs.chmod" })],
    ["actor.kind", (e: Json) => ({ ...e, actor: { kind: "robot" } })],
    ["session.mode", (e: Json) => patch(e, "session", { mode: "batch" })],
    ["env.sandbox.kind", (e: Json) => ({ ...e, env: { sandbox: { kind: "docker" } } })],
  ])("%s outside its enum", (path, mutate) => {
    expect(paths(expectInvalid(mutate(fixture("pre-bash"))))).toEqual([path]);
  });

  test.each([
    ["an array", ["ls"]],
    ["a string", "ls"],
    ["null", null],
  ])("call.input given as %s", (_label, input) => {
    expect(paths(expectInvalid(patch(MINIMAL_PRE, "call", { input })))).toEqual(["call.input"]);
  });
});

describe("parseEvent: phase and result", () => {
  test("rejects a pre event carrying a result", () => {
    const input = { ...fixture("pre-bash"), result: (fixture("post-bash") as Json).result };
    expect(paths(expectInvalid(input))).toEqual(["result"]);
  });

  test("rejects a post event without a result", () => {
    expect(paths(expectInvalid(omit(fixture("post-bash"), "result")))).toEqual(["result"]);
  });

  test("rejects a post result without ok", () => {
    const input = { ...fixture("post-bash"), result: { exit_code: 0 } };
    expect(paths(expectInvalid(input))).toEqual(["result.ok"]);
  });
});

describe("parseEvent: unknown keys", () => {
  test("rejects an unknown top-level key, naming it in the path", () => {
    const error = expectInvalid({ ...fixture("pre-bash"), verdict: "allow" });
    expect(paths(error)).toEqual(["verdict"]);
  });

  test("rejects an unknown nested key, naming it in the path", () => {
    const error = expectInvalid(patch(fixture("pre-bash"), "call", { shell: "zsh" }));
    expect(paths(error)).toEqual(["call.shell"]);
  });
});

describe("parseEvent: never throws", () => {
  test.each([
    ["null", null],
    ["undefined", undefined],
    ["a string", "jev-cops.event/1"],
    ["an array", [fixture("pre-bash")]],
    ["a number", 7],
  ])("on %s and reports a root issue", (_label, input) => {
    const error = expectInvalid(input);
    expect(paths(error)).toEqual([""]);
  });

  test("on an input whose property access throws", () => {
    const hostile = new Proxy(
      {},
      {
        get: () => {
          throw new Error("trap");
        },
      },
    );
    const error = expectInvalid(hostile);
    expect(error.issues).toEqual([{ path: "", message: "trap" }]);
  });

  test("on a cyclic input value", () => {
    const input: Json = { command: "ls" };
    input.self = input;
    expect(parseEvent(patch(MINIMAL_PRE, "call", { input })).ok).toBe(true);
  });
});

describe("parseEvent: fidelity", () => {
  test("round-trips a post event with the full spec result unchanged", () => {
    const input = fixture("post-bash");
    expect(expectValid(input)).toEqual(input as Event);
  });

  test("passes call.input through verbatim, including awkward keys", () => {
    const raw = JSON.parse(
      '{"command":"ls","__proto__":{"x":1},"nested":{"a":[1,{"b":null}]},"constructor":"c"}',
    ) as Json;
    const event = expectValid(patch(MINIMAL_PRE, "call", { input: raw }));
    expect(Object.keys(event.call.input)).toEqual([
      "command",
      "__proto__",
      "nested",
      "constructor",
    ]);
    expect(event.call.input).toEqual(raw);
  });

  test("does not mutate its input", () => {
    const input = fixture("pre-bash");
    const snapshot = structuredClone(input);
    parseEvent(input);
    parseEvent(omitIn(input, "session", "parent_id"));
    expect(input).toEqual(snapshot);
  });

  test("summarises every issue in a single-line message", () => {
    const input = omitIn(omitIn(fixture("pre-bash"), "call", "cwd"), "session", "id");
    const { message } = expectInvalid(input);
    expect(message).not.toContain("\n");
    expect(message).toContain("call.cwd");
    expect(message).toContain("session.id");
  });
});
