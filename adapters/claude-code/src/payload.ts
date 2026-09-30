/**
 * A Claude Code command hook's stdin (hooks#common-input-fields and each event's input,
 * code.claude.com/docs/en/hooks, v2.1.285) → a typed {@link HookInput}. Strict on the fields
 * jev-cops reads, lenient on every other key (dropped): a field Claude Code adds later must
 * not make every call fail. `PostToolUse`/`PostToolUseFailure` go through the daemon's own
 * schema (`@jev-cops/daemon/claude-code/post`), the one source of truth shared with the HTTP
 * post route. Never throws; an error never echoes the payload.
 */
import { CONFIG_SOURCES, START_SOURCES } from "@jev-cops/core/schema";
import {
  type ClaudeCodePostInput,
  hookIdSchema,
  parseClaudeCodePost,
} from "@jev-cops/daemon/claude-code/post";
import { z } from "zod";

/** The hook events jev-cops registers (SubagentStart and the rest are not, PLAN-M1 §2 row 13). */
export const HOOK_EVENTS = [
  "PreToolUse",
  "PostToolUse",
  "PostToolUseFailure",
  "UserPromptSubmit",
  "ConfigChange",
  "SessionStart",
  "SessionEnd",
] as const;

/** One of {@link HOOK_EVENTS}. */
export type HookEventName = (typeof HOOK_EVENTS)[number];

function isRecord(value: unknown): value is Record<string, unknown> {
  return Object.prototype.toString.call(value) === "[object Object]";
}

/** `tool_input` passed through as the same object, every key intact (D-010). */
const toolInput = z.custom<Record<string, unknown>>(isRecord, { error: "expected a JSON object" });

/** What every event carries that jev-cops reads; the rest is dropped. */
const common = {
  session_id: hookIdSchema,
  cwd: z.string().min(1),
  permission_mode: z.string().max(64).optional(),
  agent_id: hookIdSchema.optional(),
  agent_type: z.string().max(256).optional(),
};

const preToolUseSchema = z.object({
  ...common,
  hook_event_name: z.literal("PreToolUse"),
  tool_name: z.string().min(1).max(256),
  tool_input: toolInput,
  tool_use_id: hookIdSchema,
});

const userPromptSubmitSchema = z.object({
  ...common,
  hook_event_name: z.literal("UserPromptSubmit"),
  prompt: z.string(),
});

const configChangeSchema = z.object({
  ...common,
  hook_event_name: z.literal("ConfigChange"),
  source: z.enum(CONFIG_SOURCES),
  file_path: z.string().min(1).optional(),
});

const KNOWN_START_SOURCES: ReadonlySet<string> = new Set(START_SOURCES);

/** A start source Claude Code adds later is dropped, not refused: the report still goes. */
const sessionStartSchema = z.object({
  ...common,
  hook_event_name: z.literal("SessionStart"),
  source: z
    .string()
    .optional()
    .transform((s) =>
      s !== undefined && KNOWN_START_SOURCES.has(s)
        ? (s as (typeof START_SOURCES)[number])
        : undefined,
    ),
  model: z.string().min(1).max(256).optional(),
});

const sessionEndSchema = z.object({
  ...common,
  hook_event_name: z.literal("SessionEnd"),
  reason: z.string().max(200).optional(),
});

const otherSchema = z.discriminatedUnion("hook_event_name", [
  preToolUseSchema,
  userPromptSubmitSchema,
  configChangeSchema,
  sessionStartSchema,
  sessionEndSchema,
]);

/** A validated `PreToolUse` input. */
export type PreToolUseInput = z.output<typeof preToolUseSchema>;
/** A validated `UserPromptSubmit` input. */
export type UserPromptSubmitInput = z.output<typeof userPromptSubmitSchema>;
/** A validated `ConfigChange` input. */
export type ConfigChangeInput = z.output<typeof configChangeSchema>;
/** A validated `SessionStart` input (`source` only when it is a documented one). */
export type SessionStartInput = z.output<typeof sessionStartSchema>;
/** A validated `SessionEnd` input. */
export type SessionEndInput = z.output<typeof sessionEndSchema>;
/** The events reported to `/v1/session`. */
export type SessionInput =
  | UserPromptSubmitInput
  | ConfigChangeInput
  | SessionStartInput
  | SessionEndInput;
/** Any validated hook input; narrow on `hook_event_name`. */
export type HookInput = PreToolUseInput | ClaudeCodePostInput | SessionInput;
export type { ClaudeCodePostInput };

/** The parsed input, or why it was refused and which registered event it named (if any). */
export type HookParse =
  | { readonly ok: true; readonly input: HookInput }
  | { readonly ok: false; readonly error: string; readonly event: HookEventName | null };

const REGISTERED: ReadonlySet<string> = new Set(HOOK_EVENTS);

/** The registered event a payload names, or null (not an object, unknown or missing). */
export function eventNameOf(value: unknown): HookEventName | null {
  if (!isRecord(value)) return null;
  const name = value.hook_event_name;
  return typeof name === "string" && REGISTERED.has(name) ? (name as HookEventName) : null;
}

function refused(error: string, event: HookEventName | null): HookParse {
  return { ok: false, error, event };
}

/** Which fields failed, by path only: the values are the agent's and never echoed. */
function describeIssues(issues: readonly z.core.$ZodIssue[]): string {
  const paths = issues.map((i) => i.path.join(".") || "<root>");
  return `invalid ${[...new Set(paths)].join(", ")}`;
}

/**
 * Parses the text Claude Code wrote to the hook's stdin. Never throws. A refusal names the
 * registered event when the payload names one, so the caller can decide how to fail
 * (closed for tool calls and config changes, open with a warning for prompts and sessions).
 */
export function parseHookInput(text: string): HookParse {
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return refused("stdin is not JSON", null);
  }
  const event = eventNameOf(body);
  if (event === null) return refused("no registered hook_event_name", null);
  if (event === "PostToolUse" || event === "PostToolUseFailure") {
    const post = parseClaudeCodePost(body);
    return post.ok ? { ok: true, input: post.input } : refused(post.error, event);
  }
  try {
    const parsed = otherSchema.safeParse(body);
    if (parsed.success) return { ok: true, input: parsed.data };
    return refused(`${event}: ${describeIssues(parsed.error.issues)}`, event);
  } catch {
    return refused(`${event}: unreadable payload`, event);
  }
}
