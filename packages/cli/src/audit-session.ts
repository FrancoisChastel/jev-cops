import { verdictSchema } from "@jev-cops/core";
import { type AuditLine, SESSION_KILLED } from "@jev-cops/daemon";
import { z } from "zod";

/**
 * What `explain` and `replay` read from M1's session lines and latched judge lines. The
 * log is untrusted input: a line that does not match is reported or ignored, never
 * trusted blindly.
 */

/** The payload of a judge line answered by the kill latch (the daemon's `latchedPayload`). */
export const latchedPayloadSchema = z.looseObject({
  event: z.unknown(),
  latched: z.looseObject({
    root: z.string(),
    session: z.string(),
    cause: z.string(),
    at: z.number(),
    event_id: z.string(),
  }),
  returned: z.looseObject({ verdict: verdictSchema, reason: z.string() }),
  mapping: z.array(z.string()),
  enforcement: z.string(),
  home: z.string(),
});

/** A validated latched judge payload. */
export type LatchedPayload = z.output<typeof latchedPayloadSchema>;

/**
 * True for a judge line the kill latch answered: no `decision` (no policy ran), and the
 * `sessionKilled` mapping or a `latched` block. Such a line is state, not a judgement.
 */
export function isLatchedLine(line: AuditLine): boolean {
  if (line.kind !== "judge" || "decision" in line.payload) return false;
  const mapping = line.payload.mapping;
  const killed = Array.isArray(mapping) && mapping.includes(SESSION_KILLED);
  return killed || "latched" in line.payload;
}

/** The validated payload of a latched judge line, or the reason it is not one. */
export function latchedView(
  line: AuditLine,
): { ok: true; payload: LatchedPayload } | { ok: false; error: string } {
  const parsed = latchedPayloadSchema.safeParse(line.payload);
  if (parsed.success) return { ok: true, payload: parsed.data };
  const issue = parsed.error.issues[0];
  return { ok: false, error: `line ${line.seq}: ${issue?.path.join(".")}: ${issue?.message}` };
}

const eventSessionSchema = z.looseObject({
  session: z.looseObject({
    id: z.string(),
    parent_id: z.string().nullable().optional(),
    task: z.string().optional(),
  }),
});

/** The session an event names, as recorded; null when `event` is not event-shaped. */
export interface EventSession {
  readonly id: string;
  readonly parentId: string | null;
  /** The task the event itself carries (Pi sends it; Claude Code events carry none). */
  readonly task: string | null;
}

/** The session of a recorded event, or null. */
export function eventSessionOf(event: unknown): EventSession | null {
  const parsed = eventSessionSchema.safeParse(event);
  if (!parsed.success) return null;
  const { id, parent_id, task } = parsed.data.session;
  return { id, parentId: parent_id ?? null, task: task === undefined || task === "" ? null : task };
}

/** `session id → parent id` from session report lines and the events of judge/observe lines. */
function parentLinks(lines: readonly AuditLine[]): ReadonlyMap<string, string> {
  const links = lines.flatMap((l): [string, string][] => {
    if (l.kind === "session") {
      const parent = l.payload.parent_id;
      const ok = typeof parent === "string" && l.session_id !== undefined;
      return ok ? [[l.session_id as string, parent]] : [];
    }
    const s = l.kind === "judge" || l.kind === "observe" ? eventSessionOf(l.payload.event) : null;
    return s === null || s.parentId === null ? [] : [[s.id, s.parentId]];
  });
  return new Map(links);
}

/** The root session of `sessionId` as the log links it (itself when it has no parent). */
export function rootSessionOf(lines: readonly AuditLine[], sessionId: string): string {
  const parents = parentLinks(lines);
  const walk = (id: string, seen: ReadonlySet<string>): string => {
    const parent = parents.get(id);
    return parent === undefined || seen.has(parent) ? id : walk(parent, new Set([...seen, id]));
  };
  return walk(sessionId, new Set());
}

/**
 * The task a root `session` prompt line set (`task_set`, the daemon writes `task` on that
 * line only), or null for any other line. A subagent's prompt never sets it (T11).
 */
export function sessionPromptTask(line: AuditLine): { sessionId: string; task: string } | null {
  const p = line.payload;
  const isRootPrompt = line.kind === "session" && p.report === "prompt" && p.parent_id === null;
  if (!isRootPrompt || typeof p.task !== "string" || line.session_id === undefined) return null;
  return { sessionId: line.session_id, task: p.task };
}

/** The task of `sessionId`'s root: its first prompt line that set one, and that line's seq. */
export function sessionTaskOf(
  lines: readonly AuditLine[],
  sessionId: string,
): { task: string; seq: number } | null {
  const root = rootSessionOf(lines, sessionId);
  for (const line of lines) {
    const found = sessionPromptTask(line);
    if (found?.sessionId === root) return { task: found.task, seq: line.seq };
  }
  return null;
}
