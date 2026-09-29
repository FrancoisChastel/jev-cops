/**
 * Claude Code hook payloads as the hooks reference documents them (hooks#common-input-fields,
 * #posttooluse-input, #posttoolusefailure-input, #pretooluse-input), for daemon tests of
 * `POST /v1/hooks/claude-code`.
 */

/** Claude Code's own session id (a UUID); jevdict's is `sess_` + this. */
export const CLAUDE_SESSION = "0d8c3f5e-5a3b-4f0e-9d1c-2b7a6e4f9a10";

type Json = Record<string, unknown>;

/** Fields every hook input carries; `agent` makes it a subagent's call. */
export interface CommonShape {
  sessionId?: string;
  agentId?: string;
  cwd?: string;
  permissionMode?: string;
  toolUseId?: string;
}

let counter = 0;

function common(event: string, shape: CommonShape): Json {
  counter += 1;
  return {
    session_id: shape.sessionId ?? CLAUDE_SESSION,
    transcript_path: "/home/dev/.claude/projects/-work-repo/transcript.jsonl",
    cwd: shape.cwd ?? "/work/repo",
    permission_mode: shape.permissionMode ?? "default",
    hook_event_name: event,
    tool_use_id: shape.toolUseId ?? `toolu_01TEST${counter}`,
    ...(shape.agentId === undefined ? {} : { agent_id: shape.agentId, agent_type: "Explore" }),
  };
}

/** A `PostToolUse` input: the call succeeded and `tool_response` is its output. */
export function claudePost(
  tool: string,
  input: Json,
  response: unknown,
  shape: CommonShape = {},
): Json {
  return {
    ...common("PostToolUse", shape),
    tool_name: tool,
    tool_input: input,
    tool_response: response,
    duration_ms: 12,
  };
}

/** A `PostToolUseFailure` input: the call ran and failed with `error`. */
export function claudeFailure(
  tool: string,
  input: Json,
  error: string,
  shape: CommonShape & { interrupt?: boolean } = {},
): Json {
  return {
    ...common("PostToolUseFailure", shape),
    tool_name: tool,
    tool_input: input,
    error,
    is_interrupt: shape.interrupt ?? false,
  };
}

/** A `PreToolUse` input (never accepted over HTTP). */
export function claudePre(tool: string, input: Json, shape: CommonShape = {}): Json {
  return { ...common("PreToolUse", shape), tool_name: tool, tool_input: input };
}
