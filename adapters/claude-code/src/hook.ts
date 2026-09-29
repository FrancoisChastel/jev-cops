/**
 * One hook run: stdin text → {@link HookOutput}, never throwing. The whole run races the
 * hook's own deadline (13 s for `PreToolUse`, < the settings timeout of 30 s, because a
 * timed-out command hook "doesn't block the tool call", hooks#timeouts; T3), and every
 * failure has a fixed outcome (PLAN-M1 §5): tool calls and config changes fail closed,
 * prompts, posts and session reports continue with a warning.
 */
import type { HookDeps } from "./deps.ts";
import { onPreToolUse, sessionOf, unavailable } from "./events-pre.ts";
import { failClosed, type HookOutput, warn } from "./output.ts";
import { type HookEventName, type HookInput, parseHookInput } from "./payload.ts";

/** Events whose failures block: a tool call, a settings change, or an unknown event. */
const BLOCKING: ReadonlySet<HookEventName | null> = new Set([null, "PreToolUse", "ConfigChange"]);

/** `work`, or `late()` if `ms` pass first (the work is then abandoned). */
export function withDeadline<T>(work: Promise<T>, ms: number, late: () => T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(late()), ms);
  });
  return Promise.race([work, deadline]).finally(() => clearTimeout(timer));
}

function unreadable(error: string, event: HookEventName | null, deps: HookDeps): HookOutput {
  const blocking = BLOCKING.has(event);
  const outcome = blocking ? "blocking (fail closed)" : "continuing";
  const message = `unreadable hook payload (${error}); ${outcome}`;
  deps.log({ event: event ?? "unknown", session: null, message });
  return blocking ? failClosed(message) : warn(message);
}

/** What a run that reached its deadline ends with. */
function late(input: HookInput, deps: HookDeps): HookOutput {
  if (input.hook_event_name === "PreToolUse") return unavailable(input, "judge timeout", deps);
  const blocking = BLOCKING.has(input.hook_event_name);
  const message = `judge timeout; ${blocking ? "blocking (fail closed)" : "continuing"}`;
  deps.log({ event: input.hook_event_name, session: sessionOf(input), message });
  return blocking ? failClosed(message) : warn(message);
}

async function dispatch(input: HookInput, deps: HookDeps): Promise<HookOutput> {
  switch (input.hook_event_name) {
    case "PreToolUse":
      return onPreToolUse(input, deps);
    default:
      return failClosed(`${input.hook_event_name} is not handled by this hook build`);
  }
}

/** Runs the hook for one stdin payload. Never throws. */
export async function runHook(text: string, deps: HookDeps): Promise<HookOutput> {
  const parsed = parseHookInput(text);
  if (!parsed.ok) return unreadable(parsed.error, parsed.event, deps);
  const input = parsed.input;
  const pre = input.hook_event_name === "PreToolUse";
  const ms = pre ? deps.deadlines.judgeMs : deps.deadlines.eventMs;
  try {
    return await withDeadline(dispatch(input, deps), ms, () => late(input, deps));
  } catch (cause) {
    const message = `hook error (${cause instanceof Error ? cause.message : String(cause)})`;
    deps.log({ event: input.hook_event_name, session: sessionOf(input), message });
    return failClosed(`${message}; blocking (fail closed)`);
  }
}
