/**
 * The daemon's replies, reduced to what the hook acts on. Deliberately narrower than the
 * strict `jevdict.verdict/1` schema (like the Pi adapter): a field the daemon adds later
 * must not block every call, while anything the hook relies on is checked, and a reply
 * that fails a check is null, which the caller maps to "fail closed" (D-055 parity).
 */
import type { Verdict } from "@jevdict/core";
import { VERDICTS } from "@jevdict/core/schema";
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

/** The daemon's normalized raw command and detail from a confirm view, or null. */
export function parseView(body: unknown): ConfirmView | null {
  if (!isRecord(body) || typeof body.raw !== "string") return null;
  return { raw: body.raw, detail: typeof body.detail === "string" ? body.detail : null };
}
