/**
 * What `cops install`/`doctor` recorded about Claude Code in `~/.jev-cops/claude-code.json`
 * (PLAN-M1 D-076 proposal): the `claude --version` the hook reports as `harness_version`,
 * and where the install put what. Claude Code exposes no version to hooks (env-vars
 * reference), so without the file the version is omitted. Informational only; nothing is
 * decided on it.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

/** The state file's name under `~/.jev-cops/`. */
export const CLAUDE_CODE_STATE_FILE = "claude-code.json";

/** A version as `claude --version` prints it: `2.1.285`, possibly with a suffix; ≤ 64 chars. */
const VERSION = /^\d+\.\d+\.\d+[0-9A-Za-z.+-]*$/;
const MAX_VERSION_CHARS = 64;

/** The state file written by `cops install claude-code` (and read by the hook and doctor). */
export interface ClaudeCodeState {
  /** `claude --version` at install time (`2.1.285`), or null when `claude` was not found. */
  readonly claude_version: string | null;
  /** ISO timestamp of the install. */
  readonly installed_at: string;
  readonly scope: "user" | "project" | "local" | "managed";
  readonly settings_path: string;
  readonly hook_binary: string;
  readonly socket: string;
}

/** `<home>/.jev-cops/claude-code.json`. */
export function claudeCodeStatePath(home: string): string {
  return join(home, ".jev-cops", CLAUDE_CODE_STATE_FILE);
}

/** The version in `claude --version` output (`2.1.285 (Claude Code)` → `2.1.285`), or null. */
export function parseClaudeVersion(output: string): string | null {
  const token = output.trim().split(/\s+/)[0] ?? "";
  return token.length <= MAX_VERSION_CHARS && VERSION.test(token) ? token : null;
}

/** The recorded Claude Code version under `home`, or null (missing, unreadable or invalid). */
export function readHarnessVersion(home: string): string | null {
  let state: unknown;
  try {
    state = JSON.parse(readFileSync(claudeCodeStatePath(home), "utf8"));
  } catch {
    return null; // no state recorded yet: the version is simply omitted
  }
  if (typeof state !== "object" || state === null || Array.isArray(state)) return null;
  const version = (state as { claude_version?: unknown }).claude_version;
  if (typeof version !== "string" || version.length > MAX_VERSION_CHARS) return null;
  return VERSION.test(version) ? version : null;
}
