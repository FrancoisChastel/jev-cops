import { describe, expect, test } from "bun:test";
import {
  CLAUDE_CODE_FIXTURES,
  claudeCodePayload,
  claudeCodePayloadText,
} from "../../../tests/fixtures/claude-code/index.ts";
import { eventNameOf, HOOK_EVENTS, parseHookInput } from "./payload.ts";

const text = (value: unknown) => JSON.stringify(value);

describe("parseHookInput: the documented payloads", () => {
  test.each([...CLAUDE_CODE_FIXTURES])("accepts %s", (name) => {
    const parsed = parseHookInput(claudeCodePayloadText(name));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(HOOK_EVENTS).toContain(parsed.input.hook_event_name);
    expect(parsed.input.session_id).toBe("abc123");
  });

  test("a PreToolUse keeps tool_input verbatim and drops keys jev-cops does not read", () => {
    const parsed = parseHookInput(claudeCodePayloadText("pre-tool-use.bash"));
    if (!parsed.ok || parsed.input.hook_event_name !== "PreToolUse") throw new Error("parse");
    expect(parsed.input).toEqual({
      session_id: "abc123",
      cwd: "/home/user/my-project",
      permission_mode: "default",
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: {
        command: "npm test",
        description: "Run test suite",
        timeout: 120000,
        run_in_background: false,
      },
      tool_use_id: "toolu_01ABC123",
    });
  });

  test("tool_input keeps even a __proto__ key (D-010)", () => {
    const payload = `{"session_id":"s","cwd":"/w","hook_event_name":"PreToolUse","tool_name":"Bash","tool_use_id":"t","tool_input":{"__proto__":{"x":1},"command":"ls"}}`;
    const parsed = parseHookInput(payload);
    if (!parsed.ok || parsed.input.hook_event_name !== "PreToolUse") throw new Error("parse");
    expect(Object.keys(parsed.input.tool_input)).toEqual(["__proto__", "command"]);
  });

  test("a subagent call carries agent_id and agent_type", () => {
    const parsed = parseHookInput(claudeCodePayloadText("pre-tool-use.subagent"));
    expect(parsed).toMatchObject({ ok: true, input: { agent_id: "agent-abc123" } });
  });

  test("post events are parsed by the daemon's own schema", () => {
    const parsed = parseHookInput(claudeCodePayloadText("post-tool-use-failure.bash"));
    expect(parsed).toMatchObject({
      ok: true,
      input: {
        hook_event_name: "PostToolUseFailure",
        error: expect.stringContaining("Exit code 1"),
      },
    });
  });

  test("SessionStart keeps a known source and model, and drops an unknown source", () => {
    const known = parseHookInput(claudeCodePayloadText("session-start"));
    expect(known).toMatchObject({ ok: true, input: { source: "resume", model: "claude-opus-5" } });
    const later = { ...claudeCodePayload("session-start"), source: "teleport" };
    const parsed = parseHookInput(text(later));
    expect(parsed.ok && parsed.input.hook_event_name === "SessionStart").toBe(true);
    if (parsed.ok && parsed.input.hook_event_name === "SessionStart") {
      expect(parsed.input.source).toBeUndefined();
    }
  });
});

describe("parseHookInput: refusals (the caller fails closed)", () => {
  test.each([
    ["not JSON", "{", null],
    ["a JSON array", "[]", null],
    ["no hook_event_name", text({ session_id: "s", cwd: "/w" }), null],
    ["an event jev-cops does not register", text({ hook_event_name: "SubagentStart" }), null],
    ["a non-string event name", text({ hook_event_name: 7 }), null],
  ] as const)("%s: no event", (_name, payload, event) => {
    const parsed = parseHookInput(payload);
    expect(parsed).toMatchObject({ ok: false, event });
  });

  test.each([
    ["PreToolUse", { tool_input: { command: "ls" }, tool_use_id: "t" }, "tool_name"],
    ["PreToolUse", { tool_name: "Bash", tool_input: "ls", tool_use_id: "t" }, "tool_input"],
    ["PreToolUse", { tool_name: "Bash", tool_input: {}, tool_use_id: "t u" }, "tool_use_id"],
    ["UserPromptSubmit", {}, "prompt"],
    ["ConfigChange", { source: "team_settings" }, "source"],
    ["PostToolUse", { tool_name: "Bash", tool_input: {} }, "tool_use_id"],
  ] as const)("%s without a valid %s names its event", (event, fields, field) => {
    const payload = { session_id: "abc", cwd: "/w", hook_event_name: event, ...fields };
    const parsed = parseHookInput(text(payload));
    expect(parsed).toMatchObject({ ok: false, event });
    if (!parsed.ok) expect(parsed.error).toContain(field);
  });

  test("a session id with whitespace is refused (it becomes part of sess_…)", () => {
    const payload = { ...claudeCodePayload("user-prompt-submit"), session_id: "a b" };
    expect(parseHookInput(text(payload))).toMatchObject({ ok: false, event: "UserPromptSubmit" });
  });

  test("the error never echoes the payload", () => {
    const payload = {
      session_id: "s",
      cwd: "/w",
      hook_event_name: "PreToolUse",
      secret: "hunter2",
    };
    const parsed = parseHookInput(text(payload));
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error).not.toContain("hunter2");
  });
});

describe("eventNameOf", () => {
  test("names a registered event of any object, else null", () => {
    expect(eventNameOf({ hook_event_name: "ConfigChange" })).toBe("ConfigChange");
    expect(eventNameOf({ hook_event_name: "Stop" })).toBeNull();
    expect(eventNameOf("PreToolUse")).toBeNull();
    expect(eventNameOf(null)).toBeNull();
  });
});
