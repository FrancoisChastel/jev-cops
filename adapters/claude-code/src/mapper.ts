/**
 * Claude Code hook inputs → canonical jevdict messages: `jevdict.event/1` pre and post
 * events and `jevdict.session/1` reports. Translation only (D-054): `tool_input` is sent
 * verbatim and by reference, the tool name as Claude Code spells it (core maps names), no
 * `env` (the daemon derives `env.git` from the cwd, D-067) and no `task` (the daemon pins it
 * from the first prompt, D-075). Post events reuse the daemon's mapper, so the command hook
 * and the HTTP post route build the same event.
 */
import type { PostEvent, PreEvent, SessionEvent, SessionMode } from "@jevdict/core";
import { mintEventId } from "@jevdict/core/schema";
import { kindOf, toPostEvent as postEventOf, sessionIdsOf } from "@jevdict/daemon/claude-code/post";
import type { ClaudeCodePostInput, PreToolUseInput, SessionInput } from "./payload.ts";

/** What the hook knows beyond the payload. */
export interface MapContext {
  /** `claude --version` as install/doctor recorded it; null when unknown (then omitted). */
  readonly harnessVersion: string | null;
  /** Interactive unless the parent `claude` runs headless (see mode.ts). */
  readonly mode: SessionMode;
}

/** A permission mode the session schema accepts; anything else is reported as "unknown". */
const PERMISSION_MODE_ID = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
/** Reported for a mode that is not an identifier: the daemon reads it as "no human" (D-078). */
export const UNKNOWN_PERMISSION_MODE = "unknown";

function versionOf(ctx: MapContext): { harness_version?: string } {
  return ctx.harnessVersion ? { harness_version: ctx.harnessVersion } : {};
}

/** The actor of a call: a subagent when the input carries `agent_id` (hooks#common-input-fields). */
function actorOf(agentId: string | undefined): PreEvent["actor"] {
  return { kind: agentId === undefined ? "agent" : "subagent" };
}

/**
 * The canonical pre event of a `PreToolUse`: a fresh `evt_` id, `sess_<session_id>` (or
 * `sess_<session_id>.<agent_id>` under it), `call_<tool_use_id>`, the adapter's best-effort
 * kind (the daemon reclassifies, D-013) and the tool input as the same object.
 */
export function toPreEvent(i: PreToolUseInput, ctx: MapContext): PreEvent {
  return {
    schema: "jevdict.event/1",
    id: mintEventId(),
    phase: "pre",
    harness: "claude-code",
    ...versionOf(ctx),
    session: { ...sessionIdsOf(i.session_id, i.agent_id), mode: ctx.mode },
    actor: actorOf(i.agent_id),
    call: {
      id: `call_${i.tool_use_id}`,
      tool: i.tool_name,
      kind: kindOf(i.tool_name),
      input: i.tool_input,
      cwd: i.cwd,
    },
  };
}

/** The canonical post event of a `PostToolUse`/`PostToolUseFailure` (the daemon's mapper). */
export function toPostEvent(i: ClaudeCodePostInput, ctx: MapContext): PostEvent {
  return postEventOf(i, {
    eventId: mintEventId(),
    harnessVersion: ctx.harnessVersion,
    mode: ctx.mode,
  });
}

/** `permission_mode` as the session schema accepts it, or nothing when absent. */
function permissionModeOf(mode: string | undefined): { permission_mode?: string } {
  if (mode === undefined) return {};
  return { permission_mode: PERMISSION_MODE_ID.test(mode) ? mode : UNKNOWN_PERMISSION_MODE };
}

/** What a report says for its kind. */
function kindFields(i: SessionInput, intact: boolean) {
  switch (i.hook_event_name) {
    case "SessionStart":
      return {
        kind: "start" as const,
        ...(i.model === undefined ? {} : { model: i.model }),
        ...(i.source === undefined ? {} : { source: i.source }),
      };
    case "UserPromptSubmit":
      return { kind: "prompt" as const, prompt: i.prompt };
    case "SessionEnd":
      return { kind: "end" as const, ...(i.reason === undefined ? {} : { reason: i.reason }) };
    case "ConfigChange":
      return {
        kind: "config-change" as const,
        source: i.source,
        ...(i.file_path === undefined ? {} : { file_path: i.file_path }),
        intact,
      };
  }
}

/**
 * The `jevdict.session/1` report of a session event: `SessionStart` → `start` (model,
 * source), `UserPromptSubmit` → `prompt` (the first one pins the task, T11), `SessionEnd` →
 * `end`, `ConfigChange` → `config-change` with `intact` (the hook's check, see intact.ts).
 * Every report carries the session mode, cwd and permission mode, so the daemon's facts
 * (and its "no human can answer a hold" flag, D-078) follow the session.
 */
export function sessionReportOf(i: SessionInput, ctx: MapContext, intact = true): SessionEvent {
  return {
    schema: "jevdict.session/1",
    id: mintEventId(),
    harness: "claude-code",
    ...versionOf(ctx),
    session: { ...sessionIdsOf(i.session_id, i.agent_id), mode: ctx.mode },
    ...permissionModeOf(i.permission_mode),
    cwd: i.cwd,
    ...kindFields(i, intact),
  };
}
