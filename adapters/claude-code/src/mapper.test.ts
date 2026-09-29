import { describe, expect, test } from "bun:test";
import { parseEvent, parseSessionEvent } from "@jevdict/core";
import { claudeCodePayloadText } from "../../../tests/fixtures/claude-code/index.ts";
import { type MapContext, sessionReportOf, toPostEvent, toPreEvent } from "./mapper.ts";
import { type HookInput, parseHookInput } from "./payload.ts";

const CTX: MapContext = { harnessVersion: "2.1.285", mode: "interactive" };
const EVENT_ID = /^evt_[0-7][0-9A-HJKMNP-TV-Z]{25}$/;

function input(name: Parameters<typeof claudeCodePayloadText>[0]): HookInput {
  const parsed = parseHookInput(claudeCodePayloadText(name));
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.input;
}

function pre(name: Parameters<typeof claudeCodePayloadText>[0]) {
  const i = input(name);
  if (i.hook_event_name !== "PreToolUse") throw new Error("not a PreToolUse fixture");
  return i;
}

describe("toPreEvent", () => {
  test("a root call is a canonical pre event with the tool input by reference", () => {
    const i = pre("pre-tool-use.bash");
    const e = toPreEvent(i, CTX);
    expect(e).toEqual({
      schema: "jevdict.event/1",
      id: expect.stringMatching(EVENT_ID),
      phase: "pre",
      harness: "claude-code",
      harness_version: "2.1.285",
      session: { id: "sess_abc123", parent_id: null, mode: "interactive" },
      actor: { kind: "agent" },
      call: {
        id: "call_toolu_01ABC123",
        tool: "Bash",
        kind: "exec",
        input: i.tool_input,
        cwd: "/home/user/my-project",
      },
    });
    expect(e.call.input).toBe(i.tool_input);
    expect(parseEvent(e).ok).toBe(true);
  });

  test("a subagent call is its own session under the root (D-075)", () => {
    const e = toPreEvent(pre("pre-tool-use.subagent"), { ...CTX, mode: "headless" });
    expect(e.session).toEqual({
      id: "sess_abc123.agent-abc123",
      parent_id: "sess_abc123",
      mode: "headless",
    });
    expect(e.actor).toEqual({ kind: "subagent" });
    expect(e.call.kind).toBe("fs.read");
    expect(parseEvent(e).ok).toBe(true);
  });

  test("an MCP tool keeps its name and is kind other; an unknown version is omitted", () => {
    const e = toPreEvent(pre("pre-tool-use.mcp"), { ...CTX, harnessVersion: null });
    expect(e.call).toMatchObject({ tool: "mcp__memory__create_entities", kind: "other" });
    expect(e).not.toHaveProperty("harness_version");
    expect(parseEvent(e).ok).toBe(true);
  });

  test("every event gets a fresh id", () => {
    const i = pre("pre-tool-use.bash");
    expect(toPreEvent(i, CTX).id).not.toBe(toPreEvent(i, CTX).id);
  });
});

describe("toPostEvent", () => {
  test("uses the daemon's post mapper with a fresh id and the session's facts", () => {
    const i = input("post-tool-use-failure.bash");
    if (i.hook_event_name !== "PostToolUseFailure") throw new Error("fixture");
    const e = toPostEvent(i, CTX);
    expect(e).toMatchObject({
      phase: "post",
      harness_version: "2.1.285",
      session: { id: "sess_abc123", parent_id: null, mode: "interactive" },
      call: { id: "call_toolu_01ABC123", tool: "Bash" },
      result: { ok: false, exit_code: 1 },
    });
    expect(e.id).toMatch(EVENT_ID);
    expect(parseEvent(e).ok).toBe(true);
  });
});

describe("sessionReportOf", () => {
  test("SessionStart → start with mode, cwd, model and source", () => {
    const i = input("session-start");
    if (i.hook_event_name !== "SessionStart") throw new Error("fixture");
    const r = sessionReportOf(i, { ...CTX, mode: "headless" });
    expect(r).toEqual({
      schema: "jevdict.session/1",
      id: expect.stringMatching(EVENT_ID),
      harness: "claude-code",
      harness_version: "2.1.285",
      session: { id: "sess_abc123", parent_id: null, mode: "headless" },
      cwd: "/Users/dev/project",
      kind: "start",
      model: "claude-opus-5",
      source: "resume",
    });
    expect(parseSessionEvent(r).ok).toBe(true);
  });

  test("UserPromptSubmit → prompt, with the permission mode", () => {
    const i = input("user-prompt-submit");
    if (i.hook_event_name !== "UserPromptSubmit") throw new Error("fixture");
    const r = sessionReportOf(i, CTX);
    expect(r).toMatchObject({
      kind: "prompt",
      prompt: "Write a function to calculate the factorial of a number",
      permission_mode: "default",
    });
    expect(parseSessionEvent(r).ok).toBe(true);
  });

  test("SessionEnd → end with its reason", () => {
    const i = input("session-end");
    if (i.hook_event_name !== "SessionEnd") throw new Error("fixture");
    const r = sessionReportOf(i, CTX);
    expect(r).toMatchObject({ kind: "end", reason: "other" });
    expect(parseSessionEvent(r).ok).toBe(true);
  });

  test("ConfigChange → config-change with the intact verdict", () => {
    const i = input("config-change");
    if (i.hook_event_name !== "ConfigChange") throw new Error("fixture");
    const r = sessionReportOf(i, CTX, false);
    expect(r).toMatchObject({
      kind: "config-change",
      source: "project_settings",
      file_path: "/Users/dev/my-project/.claude/settings.json",
      intact: false,
    });
    expect(parseSessionEvent(r).ok).toBe(true);
  });

  test("a permission mode that is not an identifier is reported as unknown (no human, D-078)", () => {
    const i = input("user-prompt-submit");
    if (i.hook_event_name !== "UserPromptSubmit") throw new Error("fixture");
    const r = sessionReportOf({ ...i, permission_mode: "bypass permissions!" }, CTX);
    expect(r).toMatchObject({ permission_mode: "unknown" });
    expect(parseSessionEvent(r).ok).toBe(true);
  });

  test("a subagent's report is its own session under the root", () => {
    const i = input("session-end");
    if (i.hook_event_name !== "SessionEnd") throw new Error("fixture");
    const r = sessionReportOf({ ...i, agent_id: "agent-1" }, { ...CTX, harnessVersion: null });
    expect(r.session).toMatchObject({ id: "sess_abc123.agent-1", parent_id: "sess_abc123" });
    expect(r).not.toHaveProperty("harness_version");
    expect(parseSessionEvent(r).ok).toBe(true);
  });
});
