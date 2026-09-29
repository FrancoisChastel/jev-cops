import { describe, expect, test } from "bun:test";
import type { SchemaError } from "./errors.ts";
import {
  CONFIG_SOURCES,
  PERMISSION_MODES,
  parseSessionEvent,
  SESSION_EVENT_KINDS,
  SESSION_SCHEMA,
  type SessionEvent,
} from "./session.ts";

type Json = Record<string, unknown>;

const HEAD: Json = {
  schema: "jevdict.session/1",
  id: "evt_01M3PP723DWGXKY6ZN6TC6ZMXZ",
  harness: "claude-code",
  session: { id: "sess_abc" },
};

const START: Json = {
  ...HEAD,
  kind: "start",
  harness_version: "2.1.285",
  session: { id: "sess_abc", mode: "interactive", started_at: "2026-09-29T09:12:00Z" },
  cwd: "/work/repo",
  model: "claude-opus-4-6",
  source: "startup",
  permission_mode: "default",
};
const PROMPT: Json = { ...HEAD, kind: "prompt", prompt: "Fix the flaky test in auth/" };
const END: Json = { ...HEAD, kind: "end", reason: "prompt_input_exit" };
const CONFIG: Json = {
  ...HEAD,
  kind: "config-change",
  source: "user_settings",
  file_path: "/home/dev/.claude/settings.json",
  intact: false,
};

function valid(input: unknown): SessionEvent {
  const r = parseSessionEvent(input);
  if (!r.ok) throw new Error(`expected valid, got: ${r.error.message}`);
  return r.value;
}

function invalid(input: unknown): SchemaError {
  const r = parseSessionEvent(input);
  if (r.ok) throw new Error("expected the session event to be rejected");
  return r.error;
}

function paths(e: SchemaError): string[] {
  return e.issues.map((i) => i.path);
}

function without(source: Json, key: string): Json {
  return Object.fromEntries(Object.entries(source).filter(([k]) => k !== key));
}

describe("parseSessionEvent: each kind", () => {
  test("constants", () => {
    expect(SESSION_SCHEMA).toBe("jevdict.session/1");
    expect([...SESSION_EVENT_KINDS]).toEqual(["start", "prompt", "end", "config-change"]);
    expect(PERMISSION_MODES).toContain("bypassPermissions");
    expect(CONFIG_SOURCES).toContain("policy_settings");
  });

  test("start with every field", () => {
    const e = valid(START);
    expect(e.kind).toBe("start");
    expect(e.session.parent_id).toBeNull();
    if (e.kind !== "start") throw new Error("unreachable");
    expect(e).toMatchObject({ model: "claude-opus-4-6", cwd: "/work/repo" });
  });

  test("start needs cwd and session.mode; model and harness_version are optional", () => {
    expect(paths(invalid(without(START, "cwd")))).toContain("cwd");
    expect(paths(invalid({ ...START, session: { id: "sess_abc" } }))).toContain("session.mode");
    expect(valid(without(without(START, "model"), "harness_version")).kind).toBe("start");
  });

  test("prompt carries the text; an empty prompt is still a valid report", () => {
    const e = valid(PROMPT);
    if (e.kind !== "prompt") throw new Error("unreachable");
    expect(e.prompt).toBe("Fix the flaky test in auth/");
    expect(valid({ ...PROMPT, prompt: "" }).kind).toBe("prompt");
    expect(paths(invalid(without(PROMPT, "prompt")))).toContain("prompt");
    expect(paths(invalid({ ...PROMPT, prompt: 42 }))).toContain("prompt");
  });

  test("end, with or without a reason", () => {
    expect(valid(END).kind).toBe("end");
    expect(valid(without(END, "reason")).kind).toBe("end");
  });

  test("config-change needs source and intact; file_path is optional", () => {
    const e = valid(CONFIG);
    if (e.kind !== "config-change") throw new Error("unreachable");
    expect(e).toMatchObject({ source: "user_settings", intact: false });
    expect(valid(without(CONFIG, "file_path")).kind).toBe("config-change");
    expect(paths(invalid(without(CONFIG, "intact")))).toContain("intact");
    expect(paths(invalid({ ...CONFIG, intact: "yes" }))).toContain("intact");
    expect(paths(invalid({ ...CONFIG, source: "somewhere" }))).toContain("source");
  });

  test.each(SESSION_EVENT_KINDS.map((k) => [k]))("kind %s accepts a permission_mode", (kind) => {
    const base = { start: START, prompt: PROMPT, end: END, "config-change": CONFIG }[kind];
    expect(valid({ ...base, permission_mode: "bypassPermissions" }).permission_mode).toBe(
      "bypassPermissions",
    );
  });
});

describe("parseSessionEvent: rejects", () => {
  test.each([
    ["an unknown kind", { ...HEAD, kind: "resume" }, "kind"],
    ["a missing kind", HEAD, "kind"],
    ["another schema tag", { ...PROMPT, schema: "jevdict.event/1" }, "schema"],
    ["an unknown harness", { ...PROMPT, harness: "cursor" }, "harness"],
    ["an unknown top-level key", { ...PROMPT, task: "wider" }, "task"],
    ["a key of another kind", { ...PROMPT, intact: true }, "intact"],
    ["an unknown session key", { ...PROMPT, session: { id: "sess_a", task: "x" } }, "session.task"],
    ["a bad session mode", { ...PROMPT, session: { id: "sess_a", mode: "batch" } }, "session.mode"],
    ["a malformed permission mode", { ...PROMPT, permission_mode: "no way" }, "permission_mode"],
    ["an empty harness_version", { ...PROMPT, harness_version: "" }, "harness_version"],
  ])("%s", (_label, input, path) => {
    expect(paths(invalid(input))).toContain(path);
  });

  test("ids are validated like jevdict.event/1", () => {
    expect(paths(invalid({ ...PROMPT, id: "evt_nope" }))).toContain("id");
    expect(paths(invalid({ ...PROMPT, id: "01M3PP723DWGXKY6ZN6TC6ZMXZ" }))).toContain("id");
    expect(paths(invalid({ ...PROMPT, session: { id: "abc" } }))).toContain("session.id");
    expect(paths(invalid({ ...PROMPT, session: { id: "sess_a b" } }))).toContain("session.id");
    const badParent = { ...PROMPT, session: { id: "sess_a.b", parent_id: "a" } };
    expect(paths(invalid(badParent))).toContain("session.parent_id");
  });

  test.each([[null], [42], ["text"], [[]], [undefined]])(
    "a non-object %p, without throwing",
    (input) => {
      expect(parseSessionEvent(input).ok).toBe(false);
    },
  );

  test("a hostile getter does not throw", () => {
    const hostile = Object.defineProperty({ ...PROMPT }, "prompt", {
      enumerable: true,
      get() {
        throw new Error("boom");
      },
    });
    expect(parseSessionEvent(hostile).ok).toBe(false);
  });
});

describe("subagent session ids: sess_<sid>.<agent_id> with parent_id = sess_<sid>", () => {
  test("a subagent report names its root as parent", () => {
    const e = valid({ ...PROMPT, session: { id: "sess_abc.agent_7", parent_id: "sess_abc" } });
    expect(e.session).toMatchObject({ id: "sess_abc.agent_7", parent_id: "sess_abc" });
  });

  test.each([
    ["a parent that is not the id's prefix", "sess_abc.agent_7", "sess_xyz"],
    ["an id with no agent part", "sess_abc.", "sess_abc"],
    ["an id equal to its parent", "sess_abc", "sess_abc"],
    ["a prefix without the dot", "sess_abcagent", "sess_abc"],
  ])("rejects %s", (_label, id, parent) => {
    const e = invalid({ ...PROMPT, session: { id, parent_id: parent } });
    expect(paths(e)).toContain("session.id");
  });

  test("a root report with a dotted id is still a root (parent_id null)", () => {
    expect(valid({ ...PROMPT, session: { id: "sess_abc.def" } }).session.parent_id).toBeNull();
  });
});
