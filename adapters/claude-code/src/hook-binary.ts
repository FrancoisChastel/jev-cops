/**
 * Which hook binary `cops install claude-code` registers, and whether it can run (PLAN-M1
 * §5 row 1: "a mistyped path in settings.json leaves the gate silently disabled", so the
 * path is checked before it is written, and its `--version` must be the CLI's).
 */
import { accessSync, constants, existsSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type { Spawn } from "./spawn.ts";

/** The compiled hook's file name (`bun run build:hook`). */
export const HOOK_BINARY_NAME = "cops-hook";
const VERSION_TIMEOUT_MS = 10_000;

/** How the running `cops` was started (`process.execPath`, `Bun.main`). */
export interface CliRuntime {
  readonly execPath: string;
  readonly main: string;
}

function isCompiled(main: string): boolean {
  return main.startsWith("/$bunfs/") || main.startsWith("B:/~BUN/");
}

/**
 * The default hook binary: `cops-hook` next to a compiled `cops` (both in `dist/`), the
 * repo's `dist/cops-hook` when `cops` runs from source (`packages/cli/src/main.ts`), else
 * `cops-hook` on `pathEnv`; null when none exists.
 */
export function defaultHookBinary(runtime: CliRuntime, pathEnv: string): string | null {
  const sibling = isCompiled(runtime.main)
    ? join(dirname(runtime.execPath), HOOK_BINARY_NAME)
    : resolve(dirname(runtime.main), "..", "..", "..", "dist", HOOK_BINARY_NAME);
  if (existsSync(sibling)) return sibling;
  return Bun.which(HOOK_BINARY_NAME, { PATH: pathEnv });
}

/** Why `path` cannot be registered (relative, missing, not a file, not executable), or null. */
export function hookBinaryProblem(path: string): string | null {
  if (!isAbsolute(path)) return `the hook binary path must be absolute: ${path}`;
  let isFile: boolean;
  try {
    isFile = statSync(path).isFile();
  } catch {
    return `the hook binary ${path} does not exist: Claude Code would treat every call's hook as a non-blocking error and run the tool (gate silently disabled); build it with \`bun run build:hook\` or pass --hook-binary`;
  }
  if (!isFile) return `the hook binary ${path} is not a file`;
  try {
    accessSync(path, constants.X_OK);
  } catch {
    return `the hook binary ${path} is not executable (chmod +x): Claude Code would run every tool unjudged`;
  }
  return null;
}

/** True when the current user may overwrite `path` (a managed install should not allow it). */
export function isWritableByMe(path: string): boolean {
  try {
    accessSync(path, constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * True when `path` is owned by root and writable by nobody else: what a managed install
 * needs, since a user-writable binary lets the agent replace the hook it runs under.
 */
export function isRootLocked(path: string): boolean {
  try {
    const st = statSync(path);
    return st.uid === 0 && (st.mode & 0o022) === 0;
  } catch {
    return false; // unreadable: not known to be locked
  }
}

/** `<path> --version`: the version it prints, or why there is none. */
export async function hookBinaryVersion(
  path: string,
  spawn: Spawn,
  env: Readonly<Record<string, string>>,
): Promise<{ version: string | null; error: string | null }> {
  const r = await spawn({ argv: [path, "--version"], env, timeoutMs: VERSION_TIMEOUT_MS });
  if (r.exitCode !== 0) {
    const why = r.error ?? (r.timedOut ? "timed out" : `exit ${r.exitCode}: ${r.stderr.trim()}`);
    return { version: null, error: why };
  }
  const version = r.stdout.trim();
  return version === "" ? { version: null, error: "printed no version" } : { version, error: null };
}
