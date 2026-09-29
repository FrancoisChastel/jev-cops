/**
 * The events around the tool gate (PLAN-M1 step 5):
 * - `PostToolUse`/`PostToolUseFailure` → `/v1/observe`, awaited at most 2 s so an output's
 *   taint is registered before Claude reads it (D-057 parity); never blocks.
 * - `UserPromptSubmit` → `/v1/session` `prompt` (the first one pins the task, T11); the
 *   prompt of a session the daemon latched killed is blocked (D-076).
 * - `SessionStart`/`SessionEnd` → `start`/`end`, best effort.
 * - `ConfigChange` → `/v1/session` `config-change` with `intact` (intact.ts); the change is
 *   blocked unless intact, and when the daemon cannot be told (T1, D-077). `policy_settings`
 *   cannot be blocked: reported only.
 */
import { REPORT_ONLY_CONFIG_SOURCES } from "@jevdict/core/schema";
import type { HookDeps } from "./deps.ts";
import { causeOf, sessionOf } from "./events-pre.ts";
import { type MapContext, sessionReportOf, toPostEvent } from "./mapper.ts";
import { blockConfig, blockPrompt, type HookOutput, PROCEED, quiet, warn } from "./output.ts";
import type {
  ClaudeCodePostInput,
  ConfigChangeInput,
  SessionEndInput,
  SessionInput,
  SessionStartInput,
  UserPromptSubmitInput,
} from "./payload.ts";

/** What the user sees on a prompt of a killed session (the daemon's latch reason). */
export const KILLED_PROMPT = "session terminated by jevdict; start a new session";
const REPORT_ONLY: ReadonlySet<string> = new Set(REPORT_ONLY_CONFIG_SOURCES);

function contextOf(deps: HookDeps): MapContext {
  return { harnessVersion: deps.harnessVersion(), mode: deps.mode() };
}

/** Why a reply is not a success, or null when it is one. */
function failureOf(reply: { status: number } | string, ok: readonly number[]): string | null {
  if (typeof reply === "string") return reply;
  return ok.includes(reply.status) ? null : `judge unreachable (HTTP ${reply.status})`;
}

function logged(deps: HookDeps, i: SessionInput | ClaudeCodePostInput, message: string): string {
  deps.log({ event: i.hook_event_name, session: sessionOf(i), message });
  return message;
}

/** Records a tool result; a failure is logged and the result still reaches Claude. */
export async function onPost(i: ClaudeCodePostInput, deps: HookDeps): Promise<HookOutput> {
  const event = toPostEvent(i, contextOf(deps));
  const reply = await deps.client.observe(event, deps.deadlines.requestMs).catch(causeOf);
  const failed = failureOf(reply, [200, 204]);
  if (failed === null) return PROCEED;
  return quiet(logged(deps, i, `${i.tool_name}: ${failed}; observe not recorded (continuing)`));
}

async function report(i: SessionInput, deps: HookDeps, intact = true) {
  const reply = await deps.client
    .session(sessionReportOf(i, contextOf(deps), intact), deps.deadlines.requestMs)
    .catch(causeOf);
  const failed = failureOf(reply, [200]);
  const killed = typeof reply !== "string" && (reply.body as { killed?: unknown })?.killed === true;
  return { failed, killed };
}

/** Pins the task (first prompt) and blocks every prompt of a killed session. */
export async function onPrompt(i: UserPromptSubmitInput, deps: HookDeps): Promise<HookOutput> {
  const { failed, killed } = await report(i, deps);
  if (failed !== null)
    return warn(logged(deps, i, `${failed}; the prompt was not recorded (continuing)`));
  return killed ? blockPrompt(logged(deps, i, KILLED_PROMPT)) : PROCEED;
}

/** Reports a new or resumed session (model, mode, permission mode, source). */
export async function onSessionStart(i: SessionStartInput, deps: HookDeps): Promise<HookOutput> {
  const { failed, killed } = await report(i, deps);
  if (failed !== null)
    return warn(logged(deps, i, `${failed}; the session was not reported (continuing)`));
  return killed
    ? warn(logged(deps, i, `${KILLED_PROMPT}: every tool call will be blocked`))
    : PROCEED;
}

/** Reports the end of a session, best effort (the budget is 1.5 s unless raised). */
export async function onSessionEnd(i: SessionEndInput, deps: HookDeps): Promise<HookOutput> {
  const { failed } = await report(i, deps);
  return failed === null ? PROCEED : quiet(logged(deps, i, `${failed}; session end not reported`));
}

/** Checks, reports and, unless the jevdict hook is still intact and reported, blocks a settings change. */
export async function onConfigChange(i: ConfigChangeInput, deps: HookDeps): Promise<HookOutput> {
  const check = deps.configCheck(i);
  const { failed } = await report(i, deps, check.intact);
  if (REPORT_ONLY.has(i.source)) {
    const note = `${i.source} change reported (cannot be blocked): ${check.why}`;
    return quiet(logged(deps, i, failed === null ? note : `${failed}; ${note}`));
  }
  if (failed !== null)
    return blockConfig(logged(deps, i, `${failed}; settings change blocked (fail closed)`));
  if (!check.intact) return blockConfig(logged(deps, i, `settings change blocked: ${check.why}`));
  return PROCEED;
}
