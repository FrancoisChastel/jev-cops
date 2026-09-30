import type { CallKind } from "../schema/event.ts";
import { type Classification, plain } from "./classification.ts";
import { hasOption, type ParsedArgs, parseArgs } from "./options.ts";
import type { PathAccess, PathArg } from "./types.ts";
import { lastOption, pathArg, under, workDir } from "./writers.ts";

/**
 * Commands that write files their arguments do not name (M1 gate review, finding M1): an
 * archive's members and a patch's files. What can be named is: the archive or patch (read),
 * the directory they write under (`-C`, `-d`, else the cwd), and members named on the
 * command line. The files inside the archive or patch stay unknown (a printed gap).
 */

/** The directory option `names` as a path, else the cwd (implicit), with `access`. */
function dirOf(parsed: ParsedArgs, names: string[], base: number, access: PathAccess): PathArg {
  const dir = lastOption(parsed, names);
  return dir === undefined ? workDir(base, access) : pathArg(dir, base, access);
}

/** `p` resolved under `dir` when it is relative; unchanged without a dir. */
function inDir(p: PathArg, dir: string | null): PathArg {
  return dir === null || p.value.startsWith("/") ? p : { ...p, value: under(dir, p.value) };
}

type TarMode = "extract" | "create" | "list";

const TAR_MODES: Readonly<Record<string, TarMode>> = {
  "-x": "extract",
  "--extract": "extract",
  "--get": "extract",
  ...Object.fromEntries(
    ["-c", "--create", "-r", "--append", "-u", "--update", "-A", "--catenate"]
      .concat(["--concatenate", "--delete"])
      .map((o) => [o, "create"]),
  ),
  ...Object.fromEntries(["-t", "--list", "-d", "--diff", "--compare"].map((o) => [o, "list"])),
};
const TAR_TO_STDOUT = ["-O", "--to-stdout", "--to-command"];
const TAR_DIR = ["-C", "--directory"];
const OLD_STYLE = /^[A-Za-z]+$/;

/** `tar xzf a.tgz` (old style, no dash) read as `tar -xzf a.tgz`; same indexes. */
function tarArgs(args: ReadonlyArray<string>): string[] {
  const [first, ...rest] = args;
  return first !== undefined && OLD_STYLE.test(first) ? [`-${first}`, ...rest] : [...args];
}

function tarMode(parsed: ParsedArgs): TarMode | null {
  const found = parsed.options.find((o) => Object.hasOwn(TAR_MODES, o.name));
  return found === undefined ? null : (TAR_MODES[found.name] ?? null);
}

/** What one `tar` invocation reads and writes, and its kind. */
export interface TarReading {
  kind: CallKind;
  paths: PathArg[];
}

/**
 * What `tar` reads and writes: extract reads the archive (`-f`) and writes under `-C` (else
 * the cwd), members named included, unless it extracts to stdout or a command; create,
 * append, update and delete write the archive and read the operands (under `-C`); list and
 * diff read the archive. Kind `fs.write` or `fs.read`; `exec` when no mode is given.
 */
export function readTar(
  args: ReadonlyArray<string>,
  base: number,
  valueOpts: ReadonlySet<string>,
): TarReading {
  const parsed = parseArgs(tarArgs(args), valueOpts);
  const mode = tarMode(parsed);
  if (mode === null) return { kind: "exec", paths: [] };
  const file = lastOption(parsed, ["-f", "--file"]);
  const archive = file === undefined || file.value === "-" ? [] : [file];
  const dir = lastOption(parsed, TAR_DIR);
  if (mode === "create") {
    const from = dir === undefined ? [] : [pathArg(dir, base, "read")];
    const operands = parsed.positionals.map((p) =>
      inDir(pathArg(p, base, "read"), dir?.value ?? null),
    );
    const written = archive.map((a) => pathArg(a, base, "write"));
    return { kind: "fs.write", paths: [...written, ...from, ...operands] };
  }
  const read = archive.map((a) => pathArg(a, base, "read"));
  if (mode === "list" || hasOption(parsed, TAR_TO_STDOUT)) return { kind: "fs.read", paths: read };
  const into = dirOf(parsed, TAR_DIR, base, "write");
  const members = parsed.positionals.map((p) => ({
    ...pathArg(p, base, "write"),
    value: under(into.value, p.value),
  }));
  return { kind: "fs.write", paths: [...read, ...members, into] };
}

/** unzip options that list, test or print instead of extracting. */
const UNZIP_READS = ["-l", "-v", "-t", "-p", "-c", "-z", "-Z"];

/**
 * `unzip ARCHIVE [members…] [-d DIR]`: the archive is read; extracting writes under `-d`
 * (else the cwd), members named included; listing, testing and printing only read.
 */
export function classifyUnzip(args: ReadonlyArray<string>, base: number): Classification {
  const parsed = parseArgs(args, new Set(["-d", "-P"]));
  const [archive, ...members] = parsed.positionals;
  const read = archive === undefined ? [] : [pathArg(archive, base, "read")];
  if (hasOption(parsed, UNZIP_READS)) return plain("fs.read", ["unzip"], { paths: read });
  const into = dirOf(parsed, ["-d"], base, "write");
  const named = members.map((m) => ({
    ...pathArg(m, base, "write"),
    value: under(into.value, m.value),
  }));
  return plain("fs.write", ["unzip"], { paths: [...read, ...named, into] });
}

const PATCH_VALUE = new Set(
  ["-i", "--input", "-o", "--output", "-d", "--directory", "-p", "--strip", "-D"].concat(
    ["--ifdef", "-F", "--fuzz", "-B", "--prefix", "-Y", "--basename-prefix", "-z", "--suffix"],
    ["-V", "--version-control", "-r", "--reject-file", "-g", "--get", "--quoting-style"],
  ),
);
const PATCH_DIR = ["-d", "--directory"];

/**
 * `patch [opts] [FILE [PATCHFILE]]`: the patch (`-i` or PATCHFILE) is read; FILE is written
 * (read when `-o` writes elsewhere); `-o` and `-r` files are written; relative ones are
 * under `-d`. Without FILE it writes the files the patch names under `-d` (else the cwd):
 * `unknown` access to that directory.
 */
export function classifyPatch(args: ReadonlyArray<string>, base: number): Classification {
  const parsed = parseArgs(args, PATCH_VALUE);
  const dir = lastOption(parsed, PATCH_DIR)?.value ?? null;
  const [file, patchFile] = parsed.positionals;
  const output = lastOption(parsed, ["-o", "--output"]);
  const named = [
    { p: file, access: output === undefined ? "write" : "read" },
    { p: patchFile, access: "read" },
    { p: lastOption(parsed, ["-i", "--input"]), access: "read" },
    { p: output, access: "write" },
    { p: lastOption(parsed, ["-r", "--reject-file"]), access: "write" },
  ] as const;
  const paths = named.flatMap(({ p, access }) =>
    p === undefined ? [] : [inDir(pathArg(p, base, access), dir)],
  );
  const tree = file === undefined ? [dirOf(parsed, PATCH_DIR, base, "unknown")] : [];
  return plain("fs.write", ["patch"], { paths: [...tree, ...paths] });
}
