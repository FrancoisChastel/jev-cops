import { posix } from "node:path";
import { type Classification, plain } from "./classification.ts";
import { scpHost } from "./net.ts";
import {
  hasOption,
  lookup,
  type ParsedArgs,
  type ParsedOption,
  type Positional,
  parseArgs,
} from "./options.ts";
import type { PathAccess, PathArg } from "./types.ts";

/**
 * Writers whose targets are not plain positionals (M1 gate review, finding M1): `dd`'s
 * `of=`, copies whose destination may be a directory, archives and patches that write
 * under a directory. Each rule errs towards naming a write, never towards hiding one; what
 * none of them can see (the files an archive or a patch holds) is a printed gap.
 */

/** Devices `dd` reads or writes that are not files a policy protects (`/dev/sdb` is). */
const DD_DEVICE = /^\/dev\/(?:null|zero|u?random|stdin|stdout|stderr|tty|fd\/\d+)$/;
const DD_OPERAND = /^(if|of)=(.*)$/s;

/**
 * `dd`: `if=` is read, `of=` written (with `conv=notrunc` too); a device other than a disk
 * is no path. Kind `fs.write` with an `of=` file, else `fs.read`. A leading `~` after the
 * `=` is home: bash expands it in an assignment-shaped argument.
 */
export function classifyDd(args: ReadonlyArray<string>, base: number): Classification {
  const paths = args.flatMap((arg, i): PathArg[] => {
    const match = DD_OPERAND.exec(arg);
    const value = match?.[2] ?? "";
    if (value === "" || DD_DEVICE.test(value)) return [];
    const access: PathAccess = match?.[1] === "of" ? "write" : "read";
    return [{ value, index: base + i, access, tilde: true }];
  });
  const writes = paths.some((p) => p.access === "write");
  return plain(writes ? "fs.write" : "fs.read", ["dd"], { paths });
}

/** The directory a command works in when no option names one (`tar -x`, `git apply`). */
export function workDir(base: number, access: PathAccess): PathArg {
  return { value: ".", index: base - 1, access, implicit: true };
}

/** A positional or an option's value as a path argument; `base` is the argv index of `args[0]`. */
export function pathArg(p: Positional | ParsedOption, base: number, access: PathAccess): PathArg {
  return { value: p.value ?? "", index: base + p.index, access };
}

/** The last option in `names` that has a value. */
export function lastOption(
  parsed: ParsedArgs,
  names: ReadonlyArray<string>,
): ParsedOption | undefined {
  return parsed.options.filter((o) => names.includes(o.name) && o.value !== null).at(-1);
}

/** `member` under `dir` (a leading `/` stripped, as extractors do). */
export function under(dir: string, member: string): string {
  return `${dir.replace(/\/+$/, "")}/${member.replace(/^\/+/, "")}`;
}

/** Where `source` lands inside the directory `dest`, or null when on `dest` itself (`d/.`). */
function landing(dest: PathArg, source: string): PathArg | null {
  const name = posix.basename(source.replace(/\/+$/, ""));
  if (name === "" || name === "." || name === "..") return null;
  return { value: under(dest.value, name), index: dest.index, access: "write", implicit: true };
}

const TARGET_OPTS = ["-t", "--target-directory"];
const COPY_VALUE = [...TARGET_OPTS, "-S", "--suffix"];
const INSTALL_VALUE = [...COPY_VALUE, "-m", "--mode", "-o", "--owner", "-g", "--group"];

/** What a copy-like verb does to its sources, and the options that take a value. */
interface CopyRule {
  readonly source: PathAccess;
  readonly valueOpts: ReadonlyArray<string>;
}

/** `cp`, `mv`, `ln` and `install`: every copy-like verb {@link copyPaths} reads. */
export const COPY_RULES: Readonly<Record<string, CopyRule>> = {
  cp: { source: "read", valueOpts: COPY_VALUE },
  mv: { source: "delete", valueOpts: COPY_VALUE },
  ln: { source: "read", valueOpts: COPY_VALUE },
  install: { source: "read", valueOpts: [...INSTALL_VALUE, "--strip-program"] },
};

/**
 * `cp`/`mv`/`ln`/`install` paths: the sources (read; `mv` deletes them), the destination
 * (written; `-t DIR` names it), and, since the destination may be a directory, where each
 * source lands in it (`cp -r x/.claude ~` writes `~/.claude`) unless `-T` says it is not
 * one. `install -d` creates every operand. [] for another verb.
 */
export function copyPaths(name: string, args: ReadonlyArray<string>, base: number): PathArg[] {
  const rule = lookup(COPY_RULES, name);
  if (rule === undefined) return [];
  const parsed = parseArgs(args, new Set(rule.valueOpts));
  const operands = parsed.positionals;
  if (name === "install" && hasOption(parsed, ["-d", "--directory"])) {
    return operands.map((p) => pathArg(p, base, "write"));
  }
  const target = lastOption(parsed, TARGET_OPTS);
  const sources = target === undefined ? operands.slice(0, -1) : operands;
  const last = target ?? operands.at(-1);
  if (last === undefined) return [];
  if (target === undefined && sources.length === 0) return [pathArg(last, base, rule.source)];
  const dest = pathArg(last, base, "write");
  const noDir = hasOption(parsed, ["-T", "--no-target-directory"]);
  const into = noDir ? [] : sources.map((s) => landing(dest, s.value));
  const landed = into.filter((p): p is PathArg => p !== null);
  return [...sources.map((s) => pathArg(s, base, rule.source)), dest, ...landed];
}

/** rsync's local end of `[user@]host:path`, `host::module` and `rsync://`: none. */
function isRemote(operand: string): boolean {
  return operand.startsWith("rsync://") || scpHost(operand) !== null;
}

/** A remote source's path part (`host:/srv` → `/srv`), for where it lands. */
function remotePath(operand: string): string {
  return operand.slice(operand.indexOf(":") + 1).replace(/^:/, "");
}

/**
 * rsync's local paths: local sources are read, a local destination is written, and a
 * source without a trailing slash lands in it as a directory (`rsync -a x/.claude ~/`
 * writes `~/.claude`); `x/` copies the contents. A single operand only lists.
 */
export function rsyncPaths(
  args: ReadonlyArray<string>,
  base: number,
  valueOpts: ReadonlySet<string>,
): PathArg[] {
  const operands = parseArgs(args, valueOpts).positionals;
  const dest = operands.length > 1 ? operands.at(-1) : undefined;
  const sources = dest === undefined ? operands : operands.slice(0, -1);
  const reads = sources.filter((s) => !isRemote(s.value)).map((s) => pathArg(s, base, "read"));
  if (dest === undefined || isRemote(dest.value)) return reads;
  const target = pathArg(dest, base, "write");
  const landed = sources
    .filter((s) => !s.value.endsWith("/"))
    .map((s) => landing(target, isRemote(s.value) ? remotePath(s.value) : s.value))
    .filter((p): p is PathArg => p !== null);
  return [...reads, target, ...landed];
}
