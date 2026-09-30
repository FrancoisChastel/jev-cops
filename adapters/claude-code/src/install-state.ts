/**
 * The files `cops install claude-code` keeps besides the settings: the state file
 * `~/.jev-cops/claude-code.json` (whose `claude_version` the hook reports as
 * `harness_version`, D-076 proposal) and the Claude Code version it records. Every write
 * returns the previous text so a failed canary can roll it back.
 */
import { dirname } from "node:path";
import { type InstallFs, NODE_INSTALL_FS, removeFile, writeFileAtomic } from "./settings-io.ts";
import type { Spawn } from "./spawn.ts";
import { type ClaudeCodeState, claudeCodeStatePath, parseClaudeVersion } from "./state.ts";

const CLAUDE_VERSION_TIMEOUT_MS = 10_000;

/** The port and clock for a write. */
export interface WriteContext {
  readonly fs?: InstallFs;
  readonly now: Date;
}

/**
 * `claude --version` run with `env` (the caller passes the injected HOME and PATH, so a
 * test or `--home` run never reads the real Claude Code config), or null when `claude` is
 * not on PATH, fails, or prints no version.
 */
export async function claudeVersion(
  spawn: Spawn,
  env: Readonly<Record<string, string>>,
): Promise<string | null> {
  const r = await spawn({
    argv: ["claude", "--version"],
    env,
    timeoutMs: CLAUDE_VERSION_TIMEOUT_MS,
  });
  return r.exitCode === 0 ? parseClaudeVersion(r.stdout) : null;
}

/** Writes the state file (0600 in a 0700 `~/.jev-cops`); returns its path and previous text. */
export function writeClaudeCodeState(
  home: string,
  state: ClaudeCodeState,
  c: WriteContext,
): { path: string; previous: string | null } {
  const fs = c.fs ?? NODE_INSTALL_FS;
  const path = claudeCodeStatePath(home);
  const previous = fs.readFile(path);
  const text = `${JSON.stringify(state, null, 2)}\n`;
  writeFileAtomic(path, text, { mode: 0o600, dirMode: 0o700, now: c.now, fs, backup: false });
  return { path, previous };
}

/** Puts `previous` back at `path` (null: the file did not exist, so it is removed). */
export function restoreText(path: string, previous: string | null, mode: number, c: WriteContext) {
  const fs = c.fs ?? NODE_INSTALL_FS;
  if (previous === null) {
    removeFile(path, fs);
    return;
  }
  const dirMode = mode === 0o600 ? 0o700 : 0o755;
  fs.mkdirp(dirname(path), dirMode);
  writeFileAtomic(path, previous, { mode, dirMode, now: c.now, fs, backup: false });
}
