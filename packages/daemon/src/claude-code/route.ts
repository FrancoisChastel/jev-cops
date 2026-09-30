import { mintEventId, parseEvent } from "@jev-cops/core";
import type { Runtime } from "../daemon.ts";
import { observeEvent, type Reply } from "../service.ts";
import {
  type ClaudeCodePostInput,
  parseClaudeCodePost,
  sessionIdsOf,
  toPostEvent,
} from "./post.ts";

/** A `PreToolUse` sent to the HTTP route: a hook registered where it fails open. */
function refusePreToolUse(rt: Runtime, body: unknown): void {
  const sid = (body as { session_id?: unknown }).session_id;
  rt.audit.append({
    kind: "anomaly",
    payload: {
      reason: "PreToolUse over HTTP refused",
      ...(typeof sid === "string" ? { session_id: sid.slice(0, 256) } : {}),
    },
  });
}

/** The canonical post event for `input`, filled with what the session reported. */
function mapped(rt: Runtime, input: ClaudeCodePostInput) {
  const ids = sessionIdsOf(input.session_id, input.agent_id);
  const facts = rt.facts.get(rt.sessions.rootOf(ids.parent_id ?? ids.id));
  return toPostEvent(input, {
    eventId: mintEventId(),
    harnessVersion: facts?.harnessVersion ?? null,
    mode: facts?.mode ?? null,
    model: facts?.model ?? null,
  });
}

/**
 * `POST /v1/hooks/claude-code` (agent surface: Unix socket and loopback HTTP; D-066
 * proposal): the raw Claude Code `PostToolUse` / `PostToolUseFailure` payload, as an HTTP
 * hook sends it. Mapped to a canonical post event (session facts from `/v1/session` fill
 * version, mode and model), validated as `jev-cops.event/1` and recorded like
 * `/v1/observe`; answers 200 `{}` (a hook output with no decision). `PreToolUse` is
 * refused with 400 and an `anomaly` line: an HTTP hook fails open on every error, so the
 * pre-tool gate is only ever the command hook (plan §5 row 6). Anything else is 400.
 */
export async function handleClaudeCodeHook(rt: Runtime, body: unknown): Promise<Reply> {
  const parsed = parseClaudeCodePost(body);
  if (!parsed.ok) {
    if (parsed.event === "PreToolUse") refusePreToolUse(rt, body);
    return { status: 400, body: { error: parsed.error } };
  }
  const checked = parseEvent(mapped(rt, parsed.input));
  if (!checked.ok || checked.value.phase !== "post") {
    const issues = checked.ok ? [] : checked.error.issues;
    return { status: 400, body: { error: "unmappable Claude Code payload", issues } };
  }
  await observeEvent(rt, checked.value);
  return { status: 200, body: {} };
}
