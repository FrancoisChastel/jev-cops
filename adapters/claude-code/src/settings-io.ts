/**
 * How the installer writes files (PLAN-M1 §4.3 `writeSettingsFile`): a timestamped backup of
 * the previous content, then a temp file in the same directory renamed over the target, so
 * a failure at any step leaves the old file as it was. The file system is a port so tests
 * can make any step fail and can confine every write to a temp directory.
 */
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";

/** The file operations the installer uses. */
export interface InstallFs {
  /** The file's text, or null when it does not exist; throws on any other error. */
  readFile(path: string): string | null;
  /** Creates or truncates `path`, then sets exactly `mode` (whatever the umask). */
  writeFile(path: string, data: string, mode: number): void;
  rename(from: string, to: string): void;
  unlink(path: string): void;
  /** Creates missing directories with `mode`; existing ones are left as they are. */
  mkdirp(path: string, mode: number): void;
  exists(path: string): boolean;
}

/** The real file system. */
export const NODE_INSTALL_FS: InstallFs = Object.freeze({
  readFile: (path: string) => {
    try {
      return readFileSync(path, "utf8");
    } catch (cause) {
      if ((cause as { code?: string }).code === "ENOENT") return null;
      throw cause;
    }
  },
  writeFile: (path: string, data: string, mode: number) => {
    writeFileSync(path, data, { mode });
    chmodSync(path, mode);
  },
  rename: (from: string, to: string) => renameSync(from, to),
  unlink: (path: string) => unlinkSync(path),
  mkdirp: (path: string, mode: number) => {
    mkdirSync(path, { recursive: true, mode });
  },
  exists: (path: string) => existsSync(path),
});

/** Removes `path`; a file that is already gone is fine. */
export function removeFile(path: string, fs: InstallFs): void {
  try {
    fs.unlink(path);
  } catch (cause) {
    if ((cause as { code?: string }).code !== "ENOENT") throw cause;
  }
}

/** The indentation of the first indented line of `text` (spaces or tabs), else two spaces. */
export function detectIndent(text: string): string {
  return /^([ \t]+)\S/m.exec(text)?.[1] ?? "  ";
}

/** `value` as the file text: the previous file's indentation, a trailing newline. */
export function serializeSettings(value: unknown, previous: string | null): string {
  return `${JSON.stringify(value, null, detectIndent(previous ?? ""))}\n`;
}

/** `<path>.jev-cops-<UTC stamp>.bak`, suffixed `-2`, `-3`… when taken. */
export function backupPath(path: string, now: Date, fs: InstallFs): string {
  const stamp = now.toISOString().replace(/[-:.]/g, "");
  const base = `${path}.jev-cops-${stamp}`;
  let candidate = `${base}.bak`;
  for (let n = 2; fs.exists(candidate); n += 1) candidate = `${base}-${n}.bak`;
  return candidate;
}

/** How to write: file and new-directory modes, the clock for the backup name, the port. */
export interface WriteOptions {
  readonly mode: number;
  readonly dirMode: number;
  readonly now: Date;
  /** Copy the previous content aside first (default true). */
  readonly backup?: boolean;
  readonly fs?: InstallFs;
}

/**
 * Writes `text` to `path` atomically: missing directories created with `dirMode`, the old
 * content (if any) copied to {@link backupPath} (mode 0600: settings can hold secrets), a
 * temp file written with `mode` next to the target and renamed over it. On failure the temp
 * file is removed and the error rethrown; the old file is untouched.
 */
export function writeFileAtomic(
  path: string,
  text: string,
  o: WriteOptions,
): { backup: string | null } {
  const fs = o.fs ?? NODE_INSTALL_FS;
  const dir = dirname(path);
  fs.mkdirp(dir, o.dirMode);
  const previous = o.backup === false ? null : fs.readFile(path);
  const backup = previous === null ? null : backupPath(path, o.now, fs);
  if (backup !== null && previous !== null) fs.writeFile(backup, previous, 0o600);
  const nonce = Math.random().toString(36).slice(2, 10);
  const tmp = join(dir, `.${basename(path)}.jev-cops-${process.pid}-${nonce}.tmp`);
  try {
    fs.writeFile(tmp, text, o.mode);
    fs.rename(tmp, path);
  } catch (cause) {
    try {
      removeFile(tmp, fs);
    } catch {
      // best effort: the rename's own error is the one to report
    }
    throw cause;
  }
  return { backup };
}
