import type { AuditLine } from "@jev-cops/daemon";
import { z } from "zod";
import { eventSessionOf, type LatchedPayload, sessionTaskOf } from "../audit-session.ts";

/**
 * The M1 parts of `cops explain`: the session's task (an event may carry none: Claude
 * Code reports the task in a `session` prompt line), and judge lines the kill latch
 * answered, which are state, not a policy decision.
 */

const PREVIEW_CHARS = 300;

const iso = (at: number) => new Date(at).toISOString();

function preview(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > PREVIEW_CHARS ? `${flat.slice(0, PREVIEW_CHARS)}…` : flat;
}

/**
 * `task: …` for a judged event: the task it carries, else its root session's from the
 * first `session` prompt line that set one (with that line's seq), else none recorded.
 */
export function taskLine(event: unknown, lines: readonly AuditLine[]): string {
  const own = eventSessionOf(event);
  if (own === null) return "task: unknown (the recorded event names no session)";
  if (own.task !== null) return `task: ${preview(own.task)}`;
  const found = sessionTaskOf(lines, own.id);
  if (found === null)
    return "task: none recorded (not on the event, and no session prompt set one)";
  return `task: ${preview(found.task)} (from the session's first prompt, audit seq ${found.seq})`;
}

const callSchema = z.looseObject({
  call: z.looseObject({ tool: z.string(), input: z.record(z.string(), z.unknown()) }),
});

/** `call: <tool> <command, path or url>`, from the recorded event. */
function callLine(event: unknown): string {
  const parsed = callSchema.safeParse(event);
  if (!parsed.success) return "call: unreadable";
  const { tool, input } = parsed.data.call;
  const main = input.command ?? input.file_path ?? input.url ?? input.path;
  return `call: ${tool} ${preview(typeof main === "string" ? main : JSON.stringify(input))}`;
}

/** What latched the session: the kill of a judged call, or a settings change. */
function latchOrigin(l: LatchedPayload["latched"], lines: readonly AuditLine[]): string {
  if (l.cause === "kill") {
    return `latched by the kill of ${l.event_id}: cops explain ${l.event_id} shows why`;
  }
  if (l.cause !== "config-change") return `latched by ${l.event_id} (cause ${l.cause})`;
  const report = lines.find((x) => x.kind === "session" && x.event_id === l.event_id);
  const source = report?.payload.source;
  const file = report?.payload.file_path;
  const where = [source, file].filter((v): v is string => typeof v === "string").join(" ");
  return `latched by a config change: ${where || "unknown settings"} lost the cops hook block`;
}

/** `related: …` for every other line naming the event (a latch, a grant, an anomaly). */
export function relatedLines(related: readonly AuditLine[]): string[] {
  return related.map((r) => {
    const action = typeof r.payload.action === "string" ? r.payload.action : r.kind;
    const by = typeof r.payload.by === "string" ? ` by ${r.payload.by}` : "";
    return `related: ${r.kind} ${action}${by} at ${iso(r.at)}`;
  });
}

/**
 * The human rendering of a judge line the kill latch answered: no policy ran, so there is
 * no decision to explain; it says when and why the session was latched, and how it clears.
 */
export function renderLatched(
  line: AuditLine,
  p: LatchedPayload,
  related: readonly AuditLine[],
  lines: readonly AuditLine[],
): string[] {
  const l = p.latched;
  return [
    `event ${line.event_id ?? "?"} · session ${line.session_id ?? "?"} · ${iso(line.at)} · audit seq ${line.seq}`,
    `session terminated by jev-cops (latched since ${l.event_id}, cause ${l.cause})`,
    `returned to the harness: ${p.returned.verdict} (${p.mapping.join(", ")}; enforcement ${p.enforcement})`,
    `no policy ran: root session ${l.root} has been latched killed since ${iso(l.at)}`,
    latchOrigin(l, lines),
    taskLine(p.event, lines),
    callLine(p.event),
    "only a human on the admin socket clears the latch (POST /v1/session/unlatch)",
    ...relatedLines(related),
  ];
}
