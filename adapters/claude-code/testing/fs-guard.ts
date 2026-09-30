/**
 * An {@link InstallFs} that refuses any write, rename, delete or mkdir outside the given
 * roots (the test's temp HOME and project), so an install test can never touch the real
 * home directory, and records every path it wrote.
 */
import { resolve, sep } from "node:path";
import { type InstallFs, NODE_INSTALL_FS } from "../src/settings-io.ts";

/** The guarded port and the paths it wrote to. */
export interface GuardedFs extends InstallFs {
  readonly written: readonly string[];
}

/** True when `path` is one of `roots` or inside one. */
export function isUnder(path: string, roots: readonly string[]): boolean {
  const p = resolve(path);
  return roots.some((r) => p === resolve(r) || p.startsWith(`${resolve(r)}${sep}`));
}

/** The real file system, confined to `roots` for every mutation. */
export function guardedFs(roots: readonly string[], base: InstallFs = NODE_INSTALL_FS): GuardedFs {
  const written: string[] = [];
  const check = (path: string) => {
    if (!isUnder(path, roots)) throw new Error(`test escaped its temp dirs: ${path}`);
    written.push(resolve(path));
  };
  return {
    written,
    readFile: (path) => base.readFile(path),
    exists: (path) => base.exists(path),
    writeFile: (path, data, mode) => {
      check(path);
      base.writeFile(path, data, mode);
    },
    rename: (from, to) => {
      check(from);
      check(to);
      base.rename(from, to);
    },
    unlink: (path) => {
      check(path);
      base.unlink(path);
    },
    mkdirp: (path, mode) => {
      check(path);
      base.mkdirp(path, mode);
    },
  };
}
