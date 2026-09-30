import { z } from "zod";
import type { Result } from "../result.ts";
import { type SchemaError, safeParse } from "./errors.ts";
import { callIdSchema, eventIdSchema, sessionIdSchema } from "./ids.ts";

/** Version tag every canonical event carries; any other value is rejected. */
export const EVENT_SCHEMA = "jev-cops.event/1";

export const PHASES = ["pre", "post"] as const;
export const HARNESSES = ["claude-code", "codex", "opencode", "pi"] as const;
export const CALL_KINDS = [
  "exec",
  "fs.read",
  "fs.write",
  "fs.delete",
  "net",
  "spawn",
  "other",
] as const;
export const ACTOR_KINDS = ["agent", "subagent", "user"] as const;
export const SESSION_MODES = ["interactive", "headless"] as const;
export const SANDBOX_KINDS = ["openshell", "none"] as const;

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return Object.prototype.toString.call(value) === "[object Object]";
}

/**
 * Raw tool input: any JSON object, returned as the same reference with every key
 * intact (including `__proto__`). Normalization is the daemon's job, not the schema's.
 */
export const toolInputSchema = z.custom<Record<string, unknown>>(isJsonObject, {
  error: "expected a JSON object",
});

/** Session the call belongs to; `parent_id` is set for subagents and defaults to null. */
export const sessionSchema = z.strictObject({
  id: sessionIdSchema,
  parent_id: sessionIdSchema.nullable().default(null),
  task: z.string().optional(),
  mode: z.enum(SESSION_MODES).optional(),
  started_at: z.iso.datetime({ offset: true }).optional(),
});

/** Who issued the call. */
export const actorSchema = z.strictObject({
  kind: z.enum(ACTOR_KINDS),
  model: z.string().optional(),
});

/** The tool call itself. `tool` is free-form; `kind` is the adapter's closed mapping. */
export const callSchema = z.strictObject({
  id: callIdSchema,
  tool: z.string(),
  kind: z.enum(CALL_KINDS),
  input: toolInputSchema,
  cwd: z.string().min(1),
});

/** Git state of the working copy the call runs in. */
export const gitSchema = z.strictObject({
  repo: z.string().optional(),
  branch: z.string().optional(),
  dirty: z.boolean().optional(),
  default_branch: z.string().optional(),
});

/** Sandbox the agent runs in; `none` means every deny is best-effort. */
export const sandboxSchema = z.strictObject({
  kind: z.enum(SANDBOX_KINDS),
  name: z.string().optional(),
});

/** Execution environment as observed by the adapter. */
export const envSchema = z.strictObject({
  git: gitSchema.optional(),
  sandbox: sandboxSchema.optional(),
});

/** Outcome of a call, post events only: hashes and a bounded head, never full output. */
export const callResultSchema = z.strictObject({
  ok: z.boolean(),
  exit_code: z.int().optional(),
  stdout_sha256: z
    .string()
    .regex(/^[0-9a-f]{64}$/, "must be a lower-case hex SHA-256")
    .optional(),
  stdout_head: z.string().optional(),
  bytes_out: z.int().nonnegative().optional(),
});

const eventHead = {
  schema: z.literal(EVENT_SCHEMA),
  id: eventIdSchema,
};

const eventBody = {
  harness: z.enum(HARNESSES),
  harness_version: z.string().optional(),
  session: sessionSchema,
  actor: actorSchema.optional(),
  call: callSchema,
  env: envSchema.optional(),
};

/** Pre-tool event. It cannot carry a `result`: nothing has run yet. */
export const preEventSchema = z.strictObject({
  ...eventHead,
  phase: z.literal("pre"),
  ...eventBody,
  result: z.never({ error: "result is only allowed on post events" }).optional(),
});

/** Post-tool event. It must carry the `result` of the call it pairs with. */
export const postEventSchema = z.strictObject({
  ...eventHead,
  phase: z.literal("post"),
  ...eventBody,
  result: callResultSchema,
});

/**
 * Canonical `jev-cops.event/1`, the only shape the daemon accepts. Every object is
 * strict: an unknown key anywhere except inside `call.input` rejects the event.
 */
export const eventSchema = z.discriminatedUnion("phase", [preEventSchema, postEventSchema]);

/** One of {@link PHASES}. */
export type Phase = (typeof PHASES)[number];
/** One of {@link HARNESSES}. */
export type Harness = (typeof HARNESSES)[number];
/** One of {@link CALL_KINDS}. */
export type CallKind = (typeof CALL_KINDS)[number];
/** One of {@link ACTOR_KINDS}. */
export type ActorKind = (typeof ACTOR_KINDS)[number];
/** One of {@link SESSION_MODES}. */
export type SessionMode = (typeof SESSION_MODES)[number];
/** One of {@link SANDBOX_KINDS}. */
export type SandboxKind = (typeof SANDBOX_KINDS)[number];
/** Validated `session`; `parent_id` is always present, null for a root session. */
export type Session = z.output<typeof sessionSchema>;
/** Validated `actor`. */
export type Actor = z.output<typeof actorSchema>;
/** Validated `call`; `input` is the harness's raw tool input. */
export type Call = z.output<typeof callSchema>;
/** Validated `env.git`. */
export type GitInfo = z.output<typeof gitSchema>;
/** Validated `env.sandbox`. */
export type Sandbox = z.output<typeof sandboxSchema>;
/** Validated `env`. */
export type Env = z.output<typeof envSchema>;
/** Validated post-event `result`. */
export type CallResult = z.output<typeof callResultSchema>;
/** A validated pre-tool event; it never has a `result`. */
export type PreEvent = z.output<typeof preEventSchema>;
/** A validated post-tool event; its `result` is always present. */
export type PostEvent = z.output<typeof postEventSchema>;
/** A validated canonical event; narrow on `phase` to reach `result`. */
export type Event = z.output<typeof eventSchema>;

/**
 * Validates an untrusted value as a canonical event. Never throws; on failure the
 * error lists every issue with its dotted path so the adapter can fail closed.
 */
export function parseEvent(input: unknown): Result<Event, SchemaError> {
  return safeParse(eventSchema, input, EVENT_SCHEMA);
}
