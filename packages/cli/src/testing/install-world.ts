/**
 * A throw-away world for `cops install` tests: a temp root holding the home, the project,
 * a managed-settings dir and a bin dir with a `cops-hook` (the real hook run by this Bun
 * from source) and a fake `claude`; a context whose file system refuses any write outside
 * the root. Nothing here reads or writes the real home directory.
 */
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnProcess } from "@jev-cops/adapter-claude-code";
import { type GuardedFs, guardedFs } from "../../../../adapters/claude-code/testing/fs-guard.ts";
import { HOOK_SOURCE } from "../../../../adapters/claude-code/testing/setup.ts";
import type { InstallContext } from "../commands/install-context.ts";

/** The temp world and the context that runs in it. */
export interface InstallWorld {
  readonly root: string;
  readonly home: string;
  readonly project: string;
  readonly managed: string;
  readonly bin: string;
  /** `bin/cops-hook`: the real hook from source. */
  readonly hook: string;
  readonly fs: GuardedFs;
  ctx(over?: Partial<InstallContext>): InstallContext;
  /** Writes an executable script into `bin/`. */
  script(name: string, body: string): string;
  dispose(): void;
}

export const NOW = new Date("2026-09-29T09:12:00.000Z");

/** Creates the world; call `dispose` in `afterEach`. */
export function installWorld(): InstallWorld {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "jvinst-")));
  const [home, project, managed, bin] = ["home", "project", "managed", "bin"].map((d) =>
    join(root, d),
  ) as [string, string, string, string];
  for (const d of [home, project, managed, bin]) mkdirSync(d);
  const fs = guardedFs([root]);
  const script = (name: string, body: string) => {
    const path = join(bin, name);
    writeFileSync(path, `#!/bin/sh\n${body}\n`);
    chmodSync(path, 0o755);
    return path;
  };
  const hook = script("cops-hook", `exec "${process.execPath}" "${HOOK_SOURCE}" "$@"`);
  script("claude", 'echo "2.1.285 (Claude Code)"');
  const ctx = (over: Partial<InstallContext> = {}): InstallContext => ({
    env: { PATH: `${bin}:/usr/bin:/bin` },
    home,
    cwd: project,
    platform: "linux",
    isRoot: false,
    runtime: { execPath: join(root, "nowhere", "cops"), main: "/$bunfs/root/cops" },
    spawn: spawnProcess,
    fs,
    now: () => NOW,
    managedDir: managed,
    ...over,
  });
  return {
    root,
    home,
    project,
    managed,
    bin,
    hook,
    fs,
    ctx,
    script,
    dispose: () => rmSync(root, { recursive: true, force: true }),
  };
}
