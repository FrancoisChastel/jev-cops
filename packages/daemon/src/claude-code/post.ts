/**
 * Claude Code post-tool hook payloads → canonical `jevdict.event/1` post events.
 *
 * Shared by the daemon's `POST /v1/hooks/claude-code` (post events over HTTP, D-066
 * proposal) and, later, the command hook's mapper. It has no runtime dependency on
 * `@jevdict/core` (type imports only), so the lean hook binary can bundle it (D-079
 * proposal): the event id is minted by the caller and passed in.
 */
import { createHash } from "node:crypto";
import type { CallKind, CallResult, PostEvent, SessionMode } from "@jevdict/core";
import { z } from "zod";

/** Why the daemon refuses `PreToolUse` over HTTP (plan §2 row 1, §5 row 6). */
export const PRE_TOOL_USE_REFUSED = "PreToolUse must use the command hook (fails open over HTTP)";
/** Longest `stdout_head` sent (spec: "a bounded head of output"). */
export const HEAD_CHARS = 4_096;

const POST_EVENTS = new Set(["PostToolUse", "PostToolUseFailure"]);
const SHELLS = new Set(["Bash", "PowerShell"]);
const KINDS: Readonly<Record<string, CallKind>> = {
  Bash: "exec",
  PowerShell: "exec",
  Monitor: "exec",
  Read: "fs.read",
  Glob: "fs.read",
  Grep: "fs.read",
  Write: "fs.write",
  Edit: "fs.write",
  MultiEdit: "fs.write",
  NotebookEdit: "fs.write",
  WebFetch: "net",
  WebSearch: "net",
  Agent: "spawn",
  Task: "spawn",
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Object.prototype.toString.call(value) === "[object Object]";
}

/** A harness id part: non-empty, no whitespace (it becomes part of `sess_…`/`call_…`). */
const idPart = z.string().max(256).regex(/^\S+$/, "must be a non-empty id without whitespace");
/**
 * A Claude Code id (`session_id`, `agent_id`, `tool_use_id`): non-empty, no whitespace, at
 * most 256 characters. Shared with the command hook's parser for the other events.
 */
export const hookIdSchema = idPart;
/** `tool_input` passed through as the same object, every key intact (D-010). */
const toolInput = z.custom<Record<string, unknown>>(isRecord, { error: "expected a JSON object" });

/**
 * The fields jevdict reads from every tool hook input (hooks#common-input-fields). Keys
 * Claude Code adds later are dropped, not refused: a post event lost to a new field would
 * silently lose its taint (T10).
 */
const common = {
  session_id: idPart,
  cwd: z.string().min(1),
  permission_mode: z.string().max(64).optional(),
  agent_id: idPart.optional(),
  agent_type: z.string().max(256).optional(),
  tool_name: z.string().min(1).max(256),
  tool_input: toolInput,
  tool_use_id: idPart,
};

const postSchema = z.discriminatedUnion("hook_event_name", [
  z.object({
    ...common,
    hook_event_name: z.literal("PostToolUse"),
    tool_response: z.unknown().optional(),
  }),
  z.object({
    ...common,
    hook_event_name: z.literal("PostToolUseFailure"),
    error: z.string(),
    is_interrupt: z.boolean().optional(),
  }),
]);

/** A validated `PostToolUse` or `PostToolUseFailure` input. */
export type ClaudeCodePostInput = z.output<typeof postSchema>;

/** The parsed input, or why it was refused and which hook event it named (if any). */
export type PostParse =
  | { readonly ok: true; readonly input: ClaudeCodePostInput }
  | { readonly ok: false; readonly error: string; readonly event: string | null };

function refusedEvent(name: string): PostParse {
  if (name === "PreToolUse") return { ok: false, error: PRE_TOOL_USE_REFUSED, event: name };
  const shown = JSON.stringify(name.slice(0, 64));
  const error = `only PostToolUse and PostToolUseFailure are accepted over HTTP, got ${shown}`;
  return { ok: false, error, event: name.slice(0, 64) };
}

/**
 * Validates a Claude Code hook payload as a post event. Never throws. `PreToolUse` is
 * refused with {@link PRE_TOOL_USE_REFUSED}; any other non-post event by name.
 */
export function parseClaudeCodePost(body: unknown): PostParse {
  try {
    const name = isRecord(body) ? body.hook_event_name : undefined;
    if (typeof name === "string" && !POST_EVENTS.has(name)) return refusedEvent(name);
    const parsed = postSchema.safeParse(body);
    if (parsed.success) return { ok: true, input: parsed.data };
    const issues = parsed.error.issues.map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`);
    return { ok: false, error: `invalid Claude Code payload: ${issues.join("; ")}`, event: null };
  } catch {
    return { ok: false, error: "invalid Claude Code payload: unreadable", event: null };
  }
}

/** `sess_<session_id>`, or `sess_<session_id>.<agent_id>` under it (D-070 proposal). */
export function sessionIdsOf(
  sessionId: string,
  agentId?: string,
): { id: string; parent_id: string | null } {
  const root = `sess_${sessionId}`;
  return agentId === undefined
    ? { id: root, parent_id: null }
    : { id: `${root}.${agentId}`, parent_id: root };
}

/** Best-effort call kind of a Claude Code tool; the daemon reclassifies (D-013). */
export function kindOf(tool: string): CallKind {
  return Object.hasOwn(KINDS, tool) ? (KINDS[tool] ?? "other") : "other";
}

/** Canonical JSON: object keys sorted at every level, so the hash is stable. */
function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (!isRecord(value)) return JSON.stringify(value) ?? "null";
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableJson(value[k])}`).join(",")}}`;
}

function textBlocks(content: unknown[]): string {
  return content
    .filter((b): b is { text: string } => isRecord(b) && typeof b.text === "string")
    .map((b) => b.text)
    .join("\n");
}

/**
 * The text a tool response stands for: a shell's stdout + "\n" + stderr, Read's file
 * content, text blocks (Agent, MCP), WebFetch's result, a string as is, nothing as "",
 * anything else as canonical JSON.
 */
function responseText(response: unknown): string {
  if (response === undefined || response === null) return "";
  if (typeof response === "string") return response;
  if (!isRecord(response)) return stableJson(response);
  const { stdout, stderr, file, content, result } = response;
  if (typeof stdout === "string" || typeof stderr === "string") {
    return `${typeof stdout === "string" ? stdout : ""}\n${typeof stderr === "string" ? stderr : ""}`;
  }
  if (isRecord(file) && typeof file.content === "string") return file.content;
  if (Array.isArray(content)) return textBlocks(content);
  if (typeof result === "string") return result;
  return stableJson(response);
}

/** The first {@link HEAD_CHARS} UTF-16 units, never ending on half a surrogate pair. */
function head(text: string): string {
  if (text.length <= HEAD_CHARS) return text;
  const cut = text.slice(0, HEAD_CHARS);
  return /[\uD800-\uDBFF]$/.test(cut) ? cut.slice(0, -1) : cut;
}

/** The exit code a failure names: "Exit code N" or "... non-zero status code N". */
function exitCodeOf(error: string): number | undefined {
  const first = error.split("\n", 1)[0] ?? "";
  const m = /^Exit code (\d+)/.exec(first) ?? /non-zero status(?: code)? (\d+)/i.exec(first);
  return m?.[1] === undefined ? undefined : Number(m[1]);
}

/**
 * The canonical `result` of a post input: ok (a failure, an interrupt or an interrupted
 * shell is not), exit code (0 for a shell that succeeded, N from a failure's first line),
 * SHA-256 of the whole text, a bounded head, and its UTF-8 size.
 */
export function resultOf(i: ClaudeCodePostInput): CallResult {
  const failed = i.hook_event_name === "PostToolUseFailure";
  const text = failed ? i.error : responseText(i.tool_response);
  const interrupted = !failed && isRecord(i.tool_response) && i.tool_response.interrupted === true;
  const code = failed
    ? exitCodeOf(i.error)
    : SHELLS.has(i.tool_name) && !interrupted
      ? 0
      : undefined;
  return {
    ok: !failed && !interrupted,
    ...(code === undefined ? {} : { exit_code: code }),
    stdout_sha256: createHash("sha256").update(text).digest("hex"),
    stdout_head: head(text),
    bytes_out: Buffer.byteLength(text),
  };
}

/** What the caller knows beyond the payload: a fresh event id and the session's facts. */
export interface PostMapContext {
  readonly eventId: string;
  readonly harnessVersion?: string | null;
  readonly mode?: SessionMode | null;
  readonly model?: string | null;
}

/**
 * The canonical post event for a Claude Code post input: `call.id` = `call_<tool_use_id>`,
 * `call.tool` = `tool_name` verbatim (core maps names, D-054), `call.input` = `tool_input`
 * (same object), session ids per {@link sessionIdsOf}, `actor.kind` subagent when the
 * input carries `agent_id`. No `env`: the daemon derives `env.git` (D-058).
 */
export function toPostEvent(i: ClaudeCodePostInput, ctx: PostMapContext): PostEvent {
  const ids = sessionIdsOf(i.session_id, i.agent_id);
  return {
    schema: "jevdict.event/1",
    id: ctx.eventId,
    phase: "post",
    harness: "claude-code",
    ...(ctx.harnessVersion ? { harness_version: ctx.harnessVersion } : {}),
    session: { ...ids, ...(ctx.mode ? { mode: ctx.mode } : {}) },
    actor: {
      kind: i.agent_id === undefined ? "agent" : "subagent",
      ...(ctx.model ? { model: ctx.model } : {}),
    },
    call: {
      id: `call_${i.tool_use_id}`,
      tool: i.tool_name,
      kind: kindOf(i.tool_name),
      input: i.tool_input,
      cwd: i.cwd,
    },
    result: resultOf(i),
  };
}
