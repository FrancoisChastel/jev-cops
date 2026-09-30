import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mintEventId, parseEvent } from "@jev-cops/core";
import { CLAUDE_SESSION, claudeFailure, claudePost, claudePre } from "../testing/claude-code.ts";
import {
  type ClaudeCodePostInput,
  HEAD_CHARS,
  kindOf,
  PRE_TOOL_USE_REFUSED,
  parseClaudeCodePost,
  resultOf,
  sessionIdsOf,
  toPostEvent,
} from "./post.ts";

const BASH_RESPONSE = { stdout: "ok\n", stderr: "warn", interrupted: false, isImage: false };

function parsed(body: unknown): ClaudeCodePostInput {
  const r = parseClaudeCodePost(body);
  if (!r.ok) throw new Error(r.error);
  return r.input;
}

function sha(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

describe("parseClaudeCodePost", () => {
  test("accepts PostToolUse and PostToolUseFailure as documented", () => {
    const post = parsed(claudePost("Bash", { command: "ls" }, BASH_RESPONSE));
    expect(post).toMatchObject({ hook_event_name: "PostToolUse", tool_name: "Bash" });
    const failure = parsed(claudeFailure("Bash", { command: "false" }, "Exit code 1"));
    expect(failure).toMatchObject({ hook_event_name: "PostToolUseFailure", error: "Exit code 1" });
  });

  test("keeps tool_input as the same object, every key intact", () => {
    const input = JSON.parse('{"command":"ls","__proto__":{"x":1}}') as Record<string, unknown>;
    const body = claudePost("Bash", input, BASH_RESPONSE);
    expect(parsed(body).tool_input).toBe(input);
  });

  test("ignores fields Claude Code adds later (forward compatible)", () => {
    const body = { ...claudePost("Read", { file_path: "/a" }, "x"), prompt_id: "p1", new_field: 1 };
    expect(parsed(body)).not.toHaveProperty("new_field");
  });

  test("refuses PreToolUse with the fail-open reason (plan §5 row 6)", () => {
    const r = parseClaudeCodePost(claudePre("Bash", { command: "ls" }));
    expect(r).toEqual({ ok: false, error: PRE_TOOL_USE_REFUSED, event: "PreToolUse" });
    expect(PRE_TOOL_USE_REFUSED).toContain("command hook");
  });

  test("refuses every other hook event by name", () => {
    const r = parseClaudeCodePost({ hook_event_name: "UserPromptSubmit", prompt: "x" });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("unreachable");
    expect(r.event).toBe("UserPromptSubmit");
    expect(r.error).toContain("only PostToolUse and PostToolUseFailure");
  });

  test.each([
    ["a non-object", "text"],
    ["null", null],
    ["no event name", { session_id: "s" }],
    ["a session id with whitespace", claudePost("Bash", {}, "", { sessionId: "a b" })],
    ["a missing tool_use_id", { ...claudePost("Bash", {}, ""), tool_use_id: undefined }],
    ["a non-object tool_input", { ...claudePost("Bash", {}, ""), tool_input: "ls" }],
    ["a failure without error", { ...claudeFailure("Bash", {}, "e"), error: 3 }],
  ])("rejects %s without throwing", (_label, body) => {
    const r = parseClaudeCodePost(body);
    expect(r.ok).toBe(false);
  });
});

describe("sessionIdsOf and kindOf", () => {
  test("root and subagent ids (D-070 proposal)", () => {
    expect(sessionIdsOf("abc")).toEqual({ id: "sess_abc", parent_id: null });
    expect(sessionIdsOf("abc", "agent_7")).toEqual({
      id: "sess_abc.agent_7",
      parent_id: "sess_abc",
    });
  });

  test.each([
    ["Bash", "exec"],
    ["PowerShell", "exec"],
    ["Read", "fs.read"],
    ["Grep", "fs.read"],
    ["Write", "fs.write"],
    ["NotebookEdit", "fs.write"],
    ["WebFetch", "net"],
    ["Agent", "spawn"],
    ["Task", "spawn"],
    ["mcp__github__create_issue", "other"],
    ["TodoWrite", "other"],
  ])("%s → %s", (tool, kind) => {
    expect(kindOf(tool)).toBe(kind as ReturnType<typeof kindOf>);
  });
});

describe("resultOf", () => {
  test("a shell's text is stdout + newline + stderr, exit code 0 on success", () => {
    const r = resultOf(parsed(claudePost("Bash", { command: "ls" }, BASH_RESPONSE)));
    expect(r).toEqual({
      ok: true,
      exit_code: 0,
      stdout_sha256: sha("ok\n\nwarn"),
      stdout_head: "ok\n\nwarn",
      bytes_out: 8,
    });
  });

  test.each([
    ["Read's file content", "Read", { type: "text", file: { filePath: "/a", content: "A" } }, "A"],
    [
      "Agent's text blocks",
      "Agent",
      { content: [{ type: "text", text: "x" }, { type: "image" }, { type: "text", text: "y" }] },
      "x\ny",
    ],
    [
      "WebFetch's result",
      "WebFetch",
      { url: "https://a.example", result: "page", code: 200 },
      "page",
    ],
    ["a string", "mcp__s__t", "plain", "plain"],
    ["nothing", "Write", undefined, ""],
    [
      "anything else as canonical JSON",
      "Write",
      { success: true, filePath: "/a" },
      '{"filePath":"/a","success":true}',
    ],
  ])("%s", (_label, tool, response, text) => {
    const r = resultOf(parsed(claudePost(tool, {}, response)));
    expect(r.stdout_head).toBe(text);
    expect(r.stdout_sha256).toBe(sha(text));
    expect(r).not.toHaveProperty("exit_code");
  });

  test("an interrupted shell is not ok", () => {
    const r = resultOf(parsed(claudePost("Bash", {}, { ...BASH_RESPONSE, interrupted: true })));
    expect(r.ok).toBe(false);
  });

  test("the head is bounded; bytes count the whole output", () => {
    const big = `${"a".repeat(HEAD_CHARS - 1)}😀tail`;
    const r = resultOf(parsed(claudePost("Read", {}, big)));
    expect(r.stdout_head).toBe("a".repeat(HEAD_CHARS - 1));
    expect(r.bytes_out).toBe(Buffer.byteLength(big));
  });

  test.each([
    ["Exit code 2\nnpm ERR!", 2],
    ["Command exited with non-zero status code 3", 3],
    ["Permission denied", undefined],
  ])("a failure %p has exit code %p and is not ok", (error, code) => {
    const r = resultOf(parsed(claudeFailure("Bash", { command: "x" }, error)));
    expect(r.ok).toBe(false);
    expect(r.exit_code).toBe(code as number);
    expect(r.stdout_head).toBe(error);
  });
});

describe("toPostEvent", () => {
  test("a valid jev-cops.event/1 post event, ids and input as sent", () => {
    const body = claudePost("Bash", { command: "ls" }, BASH_RESPONSE, { toolUseId: "toolu_9" });
    const input = parsed(body);
    const id = mintEventId();
    const e = toPostEvent(input, { eventId: id });
    const check = parseEvent(e);
    expect(check.ok).toBe(true);
    expect(e).toMatchObject({
      id,
      phase: "post",
      harness: "claude-code",
      session: { id: `sess_${CLAUDE_SESSION}`, parent_id: null },
      actor: { kind: "agent" },
      call: { id: "call_toolu_9", tool: "Bash", kind: "exec", cwd: "/work/repo" },
      result: { ok: true, exit_code: 0 },
    });
    expect(e.call.input).toBe(input.tool_input);
    expect(e).not.toHaveProperty("harness_version");
  });

  test("a subagent call, with the session facts the daemon knows", () => {
    const input = parsed(claudePost("Read", { file_path: "/a" }, "A", { agentId: "agent_7" }));
    const e = toPostEvent(input, {
      eventId: mintEventId(),
      harnessVersion: "2.1.285",
      mode: "headless",
      model: "claude-opus-4-6",
    });
    expect(parseEvent(e).ok).toBe(true);
    expect(e).toMatchObject({
      harness_version: "2.1.285",
      session: {
        id: `sess_${CLAUDE_SESSION}.agent_7`,
        parent_id: `sess_${CLAUDE_SESSION}`,
        mode: "headless",
      },
      actor: { kind: "subagent", model: "claude-opus-4-6" },
    });
  });
});
