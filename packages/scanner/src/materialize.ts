/**
 * The directory a scanner sees (PLAN-SETUP §4.1 `materialize.ts`): the skill directory a
 * change lands in, copied as it is now (never following a symlink, `.git` skipped, bounded
 * in files, size and depth), with the change applied; then written to a private
 * `<root>/<sha256>.<random>/` (0700 dirs, 0600 files, 0700 executables) that the caller
 * removes after the scan. The content hash (SHA-256 over the sorted
 * `relative path\0bytes\0` sequence) is known before anything is written, so the daemon can
 * look its cache up first. Nothing here throws; every refusal is an error the gate holds on.
 */
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import {
  lstat,
  mkdir,
  mkdtemp,
  open,
  readdir,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { err, ok, type Result } from "@jev-cops/core";
import { applyEdits, applyNotebookEdit, type SkillChange } from "./apply-change.ts";

export type { NotebookChange, SkillChange, TextEdit } from "./apply-change.ts";

/** One file of a collected skill. */
export interface SkillFile {
  readonly bytes: Uint8Array;
  readonly executable: boolean;
}

/** A skill as it will be once the change lands, in memory, with its content hash. */
export interface CollectedSkill {
  /** By relative path (`/`-separated). */
  readonly files: ReadonlyMap<string, SkillFile>;
  readonly sha256: string;
  /** What was deliberately left out (`.git` directories), by relative path. */
  readonly skipped: readonly string[];
}

/** Bounds on what is copied; past any of them the skill is refused, never scanned in part. */
export interface MaterializeLimits {
  readonly maxFiles: number;
  readonly maxFileBytes: number;
  readonly maxDirs: number;
  readonly maxDepth: number;
}

/** 100 files of at most 1 MiB (PLAN-SETUP §4.1), 100 directories, 16 levels. */
export const DEFAULT_LIMITS: MaterializeLimits = Object.freeze({
  maxFiles: 100,
  maxFileBytes: 1024 * 1024,
  maxDirs: 100,
  maxDepth: 16,
});

/** A written scan directory. */
export interface Materialized {
  readonly dir: string;
  readonly sha256: string;
  readonly files: number;
  readonly skipped: readonly string[];
  /** Removes the directory (the caller skips it when `[scanner] keep = true`). */
  cleanup(): Promise<void>;
}

/** A refusal raised inside the walk; never escapes this module. */
class Refusal extends Error {}

interface Walk {
  readonly files: Map<string, SkillFile>;
  readonly skipped: string[];
  dirs: number;
  readonly limits: MaterializeLimits;
}

const encoder = new TextEncoder();

/** SHA-256 over the `relative path\0bytes\0` sequence, paths sorted by their UTF-8 bytes. */
export function contentHash(files: ReadonlyMap<string, SkillFile>): string {
  const hash = createHash("sha256");
  const names = [...files.keys()].sort((a, b) =>
    Buffer.compare(encoder.encode(a), encoder.encode(b)),
  );
  for (const name of names) {
    hash
      .update(encoder.encode(name))
      .update("\0")
      .update(files.get(name)?.bytes ?? new Uint8Array())
      .update("\0");
  }
  return hash.digest("hex");
}

function countFile(w: Walk, rel: string, size: number): void {
  if (size > w.limits.maxFileBytes)
    throw new Refusal(`${rel} is over ${w.limits.maxFileBytes} bytes`);
  if (!w.files.has(rel) && w.files.size + 1 > w.limits.maxFiles) {
    throw new Refusal(`more than ${w.limits.maxFiles} files in the skill`);
  }
}

/** Reads one regular file without following a symlink swapped in since `readdir`. */
async function addFile(abs: string, rel: string, w: Walk): Promise<void> {
  const fh = await open(abs, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const st = await fh.stat();
    if (!st.isFile()) throw new Refusal(`not a regular file: ${rel}`);
    countFile(w, rel, st.size);
    const bytes = new Uint8Array(await fh.readFile());
    countFile(w, rel, bytes.byteLength);
    w.files.set(rel, { bytes, executable: (st.mode & 0o100) !== 0 });
  } finally {
    await fh.close();
  }
}

async function walkDir(abs: string, rel: string, depth: number, w: Walk): Promise<void> {
  const entries = await readdir(abs, { withFileTypes: true });
  for (const e of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const childRel = rel === "" ? e.name : `${rel}/${e.name}`;
    const childAbs = join(abs, e.name);
    if (e.isSymbolicLink()) throw new Refusal(`symlink not followed: ${childRel}`);
    if (e.isFile()) {
      await addFile(childAbs, childRel, w);
    } else if (!e.isDirectory()) {
      throw new Refusal(`not a regular file: ${childRel}`);
    } else if (e.name === ".git") {
      w.skipped.push(childRel);
    } else {
      if (depth + 1 > w.limits.maxDepth) {
        throw new Refusal(`the skill is nested deeper than ${w.limits.maxDepth}`);
      }
      w.dirs += 1;
      if (w.dirs > w.limits.maxDirs) {
        throw new Refusal(`more than ${w.limits.maxDirs} directories in the skill`);
      }
      await walkDir(childAbs, childRel, depth + 1, w);
    }
  }
}

/** The skill directory to read (a symlinked skill dir is followed once), or null if absent. */
async function baseDir(skillDir: string): Promise<string | null> {
  try {
    await lstat(skillDir);
  } catch {
    return null;
  }
  const real = await realpath(skillDir);
  if (!(await stat(real)).isDirectory()) throw new Refusal(`not a directory: ${skillDir}`);
  return real;
}

/** The change's file relative to the skill dir, or why it is not inside it. */
function relativeInside(skillDir: string, file: string): Result<string, string> {
  const rel = isAbsolute(file) ? relative(skillDir, file) : "";
  const outside = rel === "" || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel);
  if (outside) return err(`${file} is not inside the skill directory ${skillDir}`);
  return ok(rel.split(sep).join("/"));
}

function withFile(w: Walk, rel: string, text: string): void {
  const bytes = encoder.encode(text);
  countFile(w, rel, bytes.byteLength);
  w.files.set(rel, { bytes, executable: w.files.get(rel)?.executable ?? false });
}

function applyChange(w: Walk, change: Exclude<SkillChange, { kind: "copy" }>, rel: string): void {
  if (change.kind === "write") {
    withFile(w, rel, change.content);
    return;
  }
  const current = w.files.get(rel);
  if (current === undefined) throw new Refusal(`the file to edit does not exist: ${rel}`);
  const text = new TextDecoder().decode(current.bytes);
  const next =
    change.kind === "edit"
      ? applyEdits(text, change.edits, rel)
      : applyNotebookEdit(text, change, rel);
  if (!next.ok) throw new Refusal(next.error);
  withFile(w, rel, next.value);
}

/**
 * The skill at `skillDir` as it will be once `change` lands, read into memory and hashed.
 * `skillDir` must be absolute; it may not exist yet for a `write` (a new skill).
 */
export async function collectSkill(
  skillDir: string,
  change: SkillChange,
  limits: MaterializeLimits = DEFAULT_LIMITS,
): Promise<Result<CollectedSkill, string>> {
  if (!isAbsolute(skillDir))
    return err(`the skill directory must be an absolute path: ${skillDir}`);
  const rel = change.kind === "copy" ? ok("") : relativeInside(skillDir, change.file);
  if (!rel.ok) return rel;
  const w: Walk = { files: new Map(), skipped: [], dirs: 0, limits };
  try {
    const base = await baseDir(skillDir);
    if (base === null && change.kind === "copy")
      return err(`nothing to scan: ${skillDir} does not exist`);
    if (base !== null) await walkDir(base, "", 0, w);
    if (change.kind !== "copy") applyChange(w, change, rel.value);
  } catch (cause) {
    if (cause instanceof Refusal) return err(cause.message);
    return err(`cannot read the skill: ${cause instanceof Error ? cause.message : String(cause)}`);
  }
  return ok({ files: w.files, sha256: contentHash(w.files), skipped: w.skipped });
}

async function writeFiles(dir: string, files: ReadonlyMap<string, SkillFile>): Promise<void> {
  for (const [rel, file] of files) {
    const target = join(dir, rel);
    if (!target.startsWith(`${dir}${sep}`)) throw new Error(`refusing to write outside ${dir}`);
    await mkdir(dirname(target), { recursive: true, mode: 0o700 });
    await writeFile(target, file.bytes, { mode: file.executable ? 0o700 : 0o600, flag: "wx" });
  }
}

/** Writes a collected skill under `root` (created 0700 when missing) in a fresh directory. */
export async function writeMaterialized(
  c: CollectedSkill,
  root: string,
): Promise<Result<Materialized, string>> {
  let dir: string;
  try {
    await mkdir(root, { recursive: true, mode: 0o700 });
    dir = await mkdtemp(join(root, `${c.sha256}.`));
  } catch (cause) {
    return err(
      `cannot create the scan directory: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }
  const cleanup = () => rm(dir, { recursive: true, force: true });
  try {
    await writeFiles(dir, c.files);
  } catch (cause) {
    await cleanup();
    return err(
      `cannot write the scan directory: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }
  return ok({ dir, sha256: c.sha256, files: c.files.size, skipped: c.skipped, cleanup });
}

/** {@link collectSkill} then {@link writeMaterialized}: nothing is written when collection fails. */
export async function materialize(
  skillDir: string,
  change: SkillChange,
  root: string,
  limits: MaterializeLimits = DEFAULT_LIMITS,
): Promise<Result<Materialized, string>> {
  const collected = await collectSkill(skillDir, change, limits);
  return collected.ok ? writeMaterialized(collected.value, root) : collected;
}
