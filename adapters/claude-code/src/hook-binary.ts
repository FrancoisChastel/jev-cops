/**
 * Which hook binary `cops install claude-code` registers, and whether it can run (PLAN-M1
 * §5 row 1: "a mistyped path in settings.json leaves the gate silently disabled", so the
 * path is checked before it is written, and its `--version` must be the CLI's).
 */
import { accessSync, constants, existsSync, statSync } from "node:fs";
import { dirname, extname, isAbsolute, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
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

/** This adapter's own `cops-hook` bin (its package.json `bin`), next to this module. */
export const OWN_HOOK_ENTRY = fileURLToPath(new URL("./hook-main.ts", import.meta.url));

function isUnderNodeModules(path: string): boolean {
  return path.split(sep).includes("node_modules");
}

/**
 * Where `cops-hook` sits for the running `cops`, most specific first:
 * - compiled `cops`: `cops-hook` next to it (both in `dist/`);
 * - `cops` from source: a `cops-hook` bin next to its entry file, same extension (the
 *   `jev-cops` package's `bin/cops.ts` → `bin/cops-hook.ts`), then the repo's
 *   `dist/cops-hook` (`packages/cli/src/main.ts` → `dist/`).
 */
function siblingHooks(runtime: CliRuntime): string[] {
  if (isCompiled(runtime.main)) return [join(dirname(runtime.execPath), HOOK_BINARY_NAME)];
  const entryDir = dirname(runtime.main);
  return [
    join(entryDir, `${HOOK_BINARY_NAME}${extname(runtime.main)}`),
    resolve(entryDir, "..", "..", "..", "dist", HOOK_BINARY_NAME),
  ];
}

/**
 * The default hook binary: the `cops-hook` shipped with the running `cops` (see
 * {@link siblingHooks}), else this adapter's own bin when it is installed from npm (under
 * `node_modules`: what `@jev-cops/cli` installed without the `jev-cops` package brings,
 * always the same version), else `cops-hook` on `pathEnv`; null when none exists.
 * `ownHook` is injectable for tests.
 */
export function defaultHookBinary(
  runtime: CliRuntime,
  pathEnv: string,
  ownHook: string = OWN_HOOK_ENTRY,
): string | null {
  const sibling = siblingHooks(runtime).find((p) => existsSync(p));
  if (sibling !== undefined) return sibling;
  if (isUnderNodeModules(ownHook) && existsSync(ownHook)) return ownHook;
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
 * True when users other than the owner may write `path` (group or world write bit, after
 * symlinks): Bun installs package bins mode 0777, and a hook anyone can rewrite is a hook
 * anyone can disable.
 */
export function isSharedWritable(path: string): boolean {
  try {
    return (statSync(path).mode & 0o022) !== 0;
  } catch {
    return false; // unreadable: nothing to report here, hookBinaryProblem covers it
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
