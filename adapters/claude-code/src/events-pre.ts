/**
 * `PreToolUse` → `/v1/judge` → hook output. A daemon that is unreachable, too slow,
 * answers non-200 or anything but this event's verdict fails the call closed, except the
 * read-only and inert tools, which proceed with a warning and a log line (PLAN-M1 §5 row 4).
 * An interactive hold loads the T8 confirm view with the view-only token the daemon sent in
 * a response header (D-079) and asks; no view, no ask.
 */
import { sessionIdsOf } from "@jevdict/daemon/claude-code/post";
import { TIMEOUT } from "./client.ts";
import type { HookDeps } from "./deps.ts";
import { toPreEvent } from "./mapper.ts";
import {
  type ConfirmView,
  failClosed,
  failOpen,
  type HookOutput,
  humanCanAnswer,
  toHookOutput,
} from "./output.ts";
import type { PreToolUseInput } from "./payload.ts";
import { failsOpen } from "./tools.ts";
import { parseJudged, parseView } from "./verdict.ts";

/** The agent-facing cause of a failed request: "judge timeout" or "judge unreachable (…)". */
export function causeOf(error: unknown): string {
  if (error instanceof Error && error.message === TIMEOUT) return TIMEOUT;
  const code = (error as { code?: unknown } | null)?.code;
  const name = typeof code === "string" ? code : error instanceof Error ? error.name : "Error";
  const message = error instanceof Error ? `${name}: ${error.message}` : String(error);
  return `judge unreachable (${message.replace(/\s+/g, " ").slice(0, 160)})`;
}

/** jevdict's id for the session of a hook input (log lines). */
export function sessionOf(i: { session_id: string; agent_id?: string | undefined }): string {
  return sessionIdsOf(i.session_id, i.agent_id).id;
}

/**
 * The call when the daemon could not judge it (`cause`): blocked, or, for a read-only or
 * inert tool, allowed with a warning; either way one line in the local log.
 */
export function unavailable(i: PreToolUseInput, cause: string, deps: HookDeps): HookOutput {
  const open = failsOpen(i.tool_name);
  const message = open
    ? `${cause}; read-only ${i.tool_name} allowed (fail open)`
    : `${cause}; blocking (fail closed)`;
  deps.log({ event: "PreToolUse", session: sessionOf(i), message: `${i.tool_name}: ${message}` });
  return open ? failOpen(message) : failClosed(message);
}

async function loadView(eventId: string, token: string | null, deps: HookDeps) {
  if (token === null) return null;
  const shown = await deps.client
    .confirmView(eventId, token, deps.deadlines.requestMs)
    .catch(() => null);
  return shown?.status === 200 ? parseView(shown.body) : null;
}

/** Judges one `PreToolUse` and maps the verdict to the hook's output. */
export async function onPreToolUse(i: PreToolUseInput, deps: HookDeps): Promise<HookOutput> {
  const mode = deps.mode();
  const event = toPreEvent(i, { harnessVersion: deps.harnessVersion(), mode });
  const reply = await deps.client.judge(event, deps.deadlines.judgeMs).catch(causeOf);
  if (typeof reply === "string") return unavailable(i, reply, deps);
  if (reply.status === 504) return unavailable(i, TIMEOUT, deps);
  if (reply.status !== 200) return unavailable(i, `judge unreachable (HTTP ${reply.status})`, deps);
  const v = parseJudged(reply.body, event.id);
  if (v === null) return unavailable(i, "judge unreachable (invalid reply, HTTP 200)", deps);
  const audience = { mode, permissionMode: i.permission_mode };
  const asks = v.verdict === "hold" && humanCanAnswer(audience);
  const view: ConfirmView | null = asks ? await loadView(event.id, reply.viewToken, deps) : null;
  return toHookOutput(v, audience, view);
}
