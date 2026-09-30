import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  FakeClaudeCode,
  type FakeClaudeOptions,
} from "../../adapters/claude-code/testing/fake-claude.ts";
import { hookCommand } from "../../adapters/claude-code/testing/setup.ts";

/** A working directory and home for one fake Claude Code session; `dispose` removes them. */
export interface ClaudeWorkspace {
  readonly cwd: string;
  readonly home: string;
  dispose(): void;
}

/** A fresh temp cwd with its own `HOME` (the hook's local log lands there). */
export function claudeWorkspace(): ClaudeWorkspace {
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), "jvtamper-cc-")));
  const home = join(cwd, "home");
  mkdirSync(home);
  return { cwd, home, dispose: () => rmSync(cwd, { recursive: true, force: true }) };
}

/**
 * A fake Claude Code (adapters/claude-code/testing) whose only hook is the jev-cops command
 * hook, run from source as a subprocess, talking to the daemon on `socket`.
 */
export function claudeCode(
  socket: string,
  ws: ClaudeWorkspace,
  o: Partial<FakeClaudeOptions> = {},
  env: Readonly<Record<string, string>> = {},
): FakeClaudeCode {
  return new FakeClaudeCode({
    hooks: [hookCommand(socket)],
    cwd: ws.cwd,
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: ws.home, ...env },
    ...o,
  });
}
