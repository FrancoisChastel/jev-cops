/**
 * The daemon's replies, reduced to what the hook acts on. Deliberately narrower than the
 * strict `jev-cops.verdict/1` schema (like the Pi adapter): a field the daemon adds later
 * must not block every call, while anything the hook relies on is checked, and a reply
 * that fails a check is null, which the caller maps to "fail closed" (D-055 parity).
 */
import type { Verdict } from "@jev-cops/core";
import { VERDICTS } from "@jev-cops/core/schema";
import type { ConfirmView, Judged } from "./output.ts";

const KNOWN: ReadonlySet<string> = new Set(VERDICTS);

function isRecord(value: unknown): value is Record<string, unknown> {
  return Object.prototype.toString.call(value) === "[object Object]";
}

/**
 * The verdict in `body` for event `eventId`, or null when the body is not one: another
 * event's verdict, an unknown verdict, no reason, or a `rewrite` without its input (a
 * rewrite must never run the original input, D-036).
 */
export function parseJudged(body: unknown, eventId: string): Judged | null {
  if (!isRecord(body) || body.event_id !== eventId || typeof body.reason !== "string") return null;
  const verdict = body.verdict;
  if (typeof verdict !== "string" || !KNOWN.has(verdict)) return null;
  const input = verdict === "rewrite" && isRecord(body.updated_input) ? body.updated_input : null;
  if (verdict === "rewrite" && input === null) return null;
  const note = typeof body.context_note === "string" ? body.context_note : null;
  return { verdict: verdict as Verdict, reason: body.reason, note, input };
}

/**
 * The daemon's normalized raw command, summary and event id from a confirm view, or null.
 * A `detail` in the body is never read: it is scored, and the ask lands in a transcript
 * the agent can read.
 */
export function parseView(body: unknown): ConfirmView | null {
  if (!isRecord(body) || typeof body.raw !== "string") return null;
  const summary = typeof body.summary === "string" ? body.summary : null;
  const eventId = typeof body.event_id === "string" ? body.event_id : null;
  return { raw: body.raw, summary, eventId };
}
