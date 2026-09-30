/**
 * Everything `cops install` reads from the process, in one injected value: the environment,
 * the home directory, the cwd, the platform and uid, how `cops` itself was started, the
 * process runner, the file system and the clock. {@link processContext} is the only place
 * the real home directory is read (`os.homedir()`); tests build their own context with a
 * temp home, and `--home` narrows the environment to it ({@link scopedEnv}).
 */

import { homedir } from "node:os";
import { resolve, sep } from "node:path";
import {
  type CliRuntime,
  type InstallFs,
  NODE_INSTALL_FS,
  type Spawn,
  spawnProcess,
} from "@jev-cops/adapter-claude-code";

/** The process as `cops install` sees it. */
export interface InstallContext {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly home: string;
  readonly cwd: string;
  readonly platform: NodeJS.Platform;
  /** Root may write Claude Code's managed settings; nobody else is asked to sudo. */
  readonly isRoot: boolean;
  readonly runtime: CliRuntime;
  readonly spawn: Spawn;
  readonly fs: InstallFs;
  readonly now: () => Date;
  /** Overrides the platform's managed-settings directory (tests). */
  readonly managedDir?: string | null;
}

/** The real process. */
export function processContext(): InstallContext {
  return {
    env: process.env,
    home: homedir(),
    cwd: process.cwd(),
    platform: process.platform,
    isRoot: typeof process.getuid === "function" && process.getuid() === 0,
    runtime: { execPath: process.execPath, main: Bun.main },
    spawn: spawnProcess,
    fs: NODE_INSTALL_FS,
    now: () => new Date(),
  };
}

/** Variables that point at configuration outside the home directory. */
const HOME_SCOPED = ["CLAUDE_CONFIG_DIR", "PI_CODING_AGENT_DIR", "JEV_COPS_CONFIG"] as const;

function inside(path: string, root: string): boolean {
  const p = resolve(path);
  const r = resolve(root);
  return p === r || p.startsWith(`${r}${sep}`);
}

/**
 * With an explicit `--home`, config-location variables that point outside it are dropped
 * (and named in `dropped`), so a `--home <tmp>` run can never write the real Claude Code, Pi
 * or jev-cops configuration. Without `--home` the environment is used as is.
 */
export function scopedEnv(
  env: Readonly<Record<string, string | undefined>>,
  home: string,
  explicitHome: boolean,
): { env: Readonly<Record<string, string | undefined>>; dropped: string[] } {
  if (!explicitHome) return { env, dropped: [] };
  const dropped = HOME_SCOPED.filter((k) => {
    const v = env[k];
    return v !== undefined && v !== "" && !inside(v, home);
  });
  const drop = new Set<string>(dropped);
  const kept = Object.fromEntries(Object.entries(env).filter(([k]) => !drop.has(k)));
  return { env: kept, dropped: [...dropped] };
}
