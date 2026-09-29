/**
 * The hook's local log, `~/.jevdict/claude-code-hook.log`: one line per failure the hook
 * handled on its own (a read that failed open, a call blocked because the daemon was
 * unreachable, a report that could not be sent). Spec T2: "observe-only events log locally
 * and continue". `jevdict doctor` reports its size. Never contains tool input or output.
 */
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

/** The log's file name under `~/.jevdict/`. */
export const HOOK_LOG_FILE = "claude-code-hook.log";
const MAX_MESSAGE_CHARS = 1_000;

/** One log entry: the hook event, jevdict's session id when known, and what happened. */
export interface HookLogLine {
  readonly event: string;
  readonly session: string | null;
  readonly message: string;
}

/** Where the hook logs, under `home`. */
export function hookLogPath(home: string): string {
  return join(home, ".jevdict", HOOK_LOG_FILE);
}

/**
 * Appends one line (`<iso time> <event> <session|-> <message>`, control characters folded
 * to spaces, message capped) to `path`, creating its directory (0700) and the file (0600).
 * Throws when it cannot write; the caller reports that on stderr.
 */
export function appendHookLog(path: string, line: HookLogLine, at: Date): void {
  const message = line.message.replace(/\p{Cc}+/gu, " ").slice(0, MAX_MESSAGE_CHARS);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const text = `${at.toISOString()} ${line.event} ${line.session ?? "-"} ${message}\n`;
  appendFileSync(path, text, { mode: 0o600 });
}
