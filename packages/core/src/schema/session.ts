import { z } from "zod";
import type { Result } from "../result.ts";
import { type SchemaError, safeParse } from "./errors.ts";
import { HARNESSES, SESSION_MODES } from "./event.ts";
import { eventIdSchema, sessionIdSchema } from "./ids.ts";

/** Version tag every session report carries; any other value is rejected. */
export const SESSION_SCHEMA = "jevdict.session/1";

/**
 * What a session report says: the session began (`start`), the user submitted a prompt
 * (`prompt`; the first one pins the task, T11), the session ended (`end`), or a harness
 * settings file changed while it ran (`config-change`, T1).
 */
export const SESSION_EVENT_KINDS = ["start", "prompt", "end", "config-change"] as const;

/**
 * Claude Code permission modes (hooks#common-input-fields). The schema accepts any short
 * identifier so a mode added upstream does not drop the report (and with it the task);
 * the daemon treats a mode it does not know as one where no human answers.
 */
export const PERMISSION_MODES = [
  "default",
  "plan",
  "acceptEdits",
  "auto",
  "dontAsk",
  "bypassPermissions",
] as const;

/** Permission modes in which no human answers a prompt, so a `hold` must become `deny`. */
export const NO_HUMAN_PERMISSION_MODES = ["dontAsk", "bypassPermissions"] as const;

/** Where a session (re)started (Claude Code `SessionStart.source`). */
export const START_SOURCES = ["startup", "resume", "clear", "compact", "fork"] as const;

/** Which settings changed (Claude Code `ConfigChange` matchers). */
export const CONFIG_SOURCES = [
  "user_settings",
  "project_settings",
  "local_settings",
  "policy_settings",
  "skills",
] as const;

/** Config sources the harness cannot block (root-owned managed settings): report only. */
export const REPORT_ONLY_CONFIG_SOURCES = ["policy_settings"] as const;

const PERMISSION_MODE = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;

/** The session a report is about; the same shape as an event's, without `task`. */
const reportSessionSchema = z.strictObject({
  id: sessionIdSchema,
  parent_id: sessionIdSchema.nullable().default(null),
  mode: z.enum(SESSION_MODES).optional(),
  started_at: z.iso.datetime({ offset: true }).optional(),
});

const head = {
  schema: z.literal(SESSION_SCHEMA),
  id: eventIdSchema,
  harness: z.enum(HARNESSES),
  harness_version: z.string().min(1).max(64).optional(),
  session: reportSessionSchema,
  permission_mode: z
    .string()
    .regex(PERMISSION_MODE, "must be a permission mode identifier")
    .optional(),
  cwd: z.string().min(1).optional(),
};

/** `start`: the harness, its version, the model, the mode and the cwd of a new session. */
export const sessionStartSchema = z.strictObject({
  ...head,
  kind: z.literal("start"),
  session: reportSessionSchema.extend({ mode: z.enum(SESSION_MODES) }),
  cwd: z.string().min(1),
  model: z.string().min(1).optional(),
  source: z.enum(START_SOURCES).optional(),
});

/** `prompt`: a user prompt, before the model sees it. Only the first one sets the task. */
export const sessionPromptSchema = z.strictObject({
  ...head,
  kind: z.literal("prompt"),
  prompt: z.string(),
});

/** `end`: the session ended (best effort; the harness may exit first). */
export const sessionEndSchema = z.strictObject({
  ...head,
  kind: z.literal("end"),
  reason: z.string().max(200).optional(),
});

/**
 * `config-change`: a settings file changed mid-session. `intact` is the adapter's check
 * that the file still carries the jevdict hook block and does not disable hooks.
 */
export const sessionConfigChangeSchema = z.strictObject({
  ...head,
  kind: z.literal("config-change"),
  source: z.enum(CONFIG_SOURCES),
  file_path: z.string().min(1).optional(),
  intact: z.boolean(),
});

/**
 * Canonical `jevdict.session/1`: strict at every level, discriminated on `kind`. A
 * subagent report (`parent_id` set) must use the id `<parent_id>.<agent_id>`.
 */
export const sessionEventSchema = z
  .discriminatedUnion("kind", [
    sessionStartSchema,
    sessionPromptSchema,
    sessionEndSchema,
    sessionConfigChangeSchema,
  ])
  .superRefine((e, ctx) => {
    const parent = e.session.parent_id;
    if (parent === null) return;
    const id = e.session.id;
    if (!id.startsWith(`${parent}.`) || id.length <= parent.length + 1) {
      ctx.addIssue({
        code: "custom",
        path: ["session", "id"],
        message: `a subagent session id must be "${parent}.<agent_id>"`,
      });
    }
  });

/** One of {@link SESSION_EVENT_KINDS}. */
export type SessionEventKind = (typeof SESSION_EVENT_KINDS)[number];
/** One of {@link PERMISSION_MODES} (the schema also admits newer identifiers). */
export type PermissionMode = (typeof PERMISSION_MODES)[number];
/** One of {@link CONFIG_SOURCES}. */
export type ConfigSource = (typeof CONFIG_SOURCES)[number];
/** A validated `jevdict.session/1` report; narrow on `kind`. */
export type SessionEvent = z.output<typeof sessionEventSchema>;

/**
 * Validates an untrusted value as a session report. Never throws; on failure the error
 * lists every issue with its dotted path.
 */
export function parseSessionEvent(input: unknown): Result<SessionEvent, SchemaError> {
  return safeParse(sessionEventSchema, input, SESSION_SCHEMA);
}
