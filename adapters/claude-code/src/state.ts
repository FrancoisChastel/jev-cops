/**
 * What `jevdict install`/`doctor` recorded about Claude Code in `~/.jevdict/claude-code.json`
 * (PLAN-M1 D-076 proposal): the `claude --version` the hook reports as `harness_version`.
 * Claude Code exposes no version to hooks (env-vars reference), so without the file the
 * version is omitted. Informational only; nothing is decided on it.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

/** The state file's name under `~/.jevdict/`. */
export const CLAUDE_CODE_STATE_FILE = "claude-code.json";

/** A version as `claude --version` prints it: `2.1.285`, possibly with a suffix; ≤ 64 chars. */
const VERSION = /^\d+\.\d+\.\d+[0-9A-Za-z.+-]*$/;
const MAX_VERSION_CHARS = 64;

/** The recorded Claude Code version under `home`, or null (missing, unreadable or invalid). */
export function readHarnessVersion(home: string): string | null {
  let state: unknown;
  try {
    state = JSON.parse(readFileSync(join(home, ".jevdict", CLAUDE_CODE_STATE_FILE), "utf8"));
  } catch {
    return null; // no state recorded yet: the version is simply omitted
  }
  if (typeof state !== "object" || state === null || Array.isArray(state)) return null;
  const version = (state as { claude_version?: unknown }).claude_version;
  if (typeof version !== "string" || version.length > MAX_VERSION_CHARS) return null;
  return VERSION.test(version) ? version : null;
}
