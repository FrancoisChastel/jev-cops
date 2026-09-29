import { posix } from "node:path";
import type { CallKind } from "../schema/event.ts";
import { type Classification, type InterpreterInfo, maxKind, plain } from "./classification.ts";
import { filePaths, rmVerbs, sedEffects, sedMode } from "./files.ts";
import { GIT_SUBCOMMAND_KINDS, readGit } from "./git.ts";
import { classifyInterpreter } from "./interpreters.ts";
import { readCurl, readWget, urlHost, verbHosts } from "./net.ts";
import { hasOption, lookup, type Positional, parseArgs } from "./options.ts";
import { looksLikePath } from "./paths.ts";
import type { PathArg } from "./types.ts";

export {
  type Classification,
  COMMAND_KIND_ORDER,
  type InterpreterInfo,
  maxKind,
} from "./classification.ts";
export { FILE_RULES } from "./files.ts";
export { INTERPRETER_INLINE_FLAGS, SHELLS } from "./interpreters.ts";

function kinds(kind: CallKind, verbs: ReadonlyArray<string>): Record<string, CallKind> {
  return Object.fromEntries(verbs.map((v) => [v, kind]));
}

/**
 * Verb → kind for commands classified by name alone; anything absent is `exec`.
 * `sed`, `rsync`, `git`, `npm`, `pip`, `docker`, wrappers and interpreters have their
 * own rules (sed -n reads / -i writes, rsync is net only with a remote).
 */
export const VERB_KINDS: Readonly<Record<string, CallKind>> = {
  ...kinds("fs.read", ["cat", "head", "tail", "less", "more", "awk", "grep", "rg", "find"]),
  ...kinds("fs.read", ["ls", "stat", "file", "wc", "strings"]),
  ...kinds("fs.write", ["tee", "cp", "mv", "touch", "mkdir", "chmod", "chown", "ln"]),
  ...kinds("fs.delete", ["rm", "unlink", "rmdir", "shred", "truncate"]),
  ...kinds("net", ["curl", "wget", "ssh", "scp", "sftp", "nc", "ncat", "telnet", "ftp"]),
  ...kinds("spawn", ["tmux", "screen"]),
};

/** Verb → subcommand → kind; subcommands not listed are `exec`. */
export const SUBCOMMAND_KINDS: Readonly<Record<string, Readonly<Record<string, CallKind>>>> = {
  git: GIT_SUBCOMMAND_KINDS,
  npm: { publish: "net" },
  pip: { download: "net" },
  pip3: { download: "net" },
  docker: { push: "net", pull: "net", run: "spawn" },
};

const SUBCOMMAND_GLOBALS: Readonly<Record<string, ReadonlySet<string>>> = {
  docker: new Set(["-H", "--host", "--config", "--context", "-c", "-l", "--log-level"]),
};

/**
 * A command that runs another command. `opaque` wrappers hide what runs or as whom and
 * flag the call `interpreter`; `kind` combines with the wrapped command's; `leading`
 * positionals (timeout's duration) precede the command; `assignments` allows
 * `NAME=value` words before it.
 */
export interface WrapperRule {
  valueOpts: ReadonlyArray<string>;
  verbs: ReadonlyArray<string>;
  opaque: boolean;
  leading: number;
  kind: CallKind | null;
  assignments: boolean;
}

function wrapper(verbs: string[], opaque: boolean, valueOpts: string[] = []): WrapperRule {
  return { valueOpts, verbs, opaque, leading: 0, kind: null, assignments: false };
}

/** Every wrapper the classifier unwraps; the wrapped command is classified in its place. */
export const WRAPPERS: Readonly<Record<string, WrapperRule>> = {
  env: { ...wrapper(["env"], true, ["-u", "--unset", "-C", "--chdir"]), assignments: true },
  nohup: { ...wrapper(["nohup"], true), kind: "spawn" },
  setsid: { ...wrapper(["setsid"], true), kind: "spawn" },
  sudo: {
    ...wrapper(["sudo", "privilege"], true, ["-u", "-g", "-C", "-D", "-h", "-p", "-r", "-t"]),
    assignments: true,
  },
  doas: wrapper(["doas", "privilege"], true, ["-u", "-C"]),
  timeout: { ...wrapper(["timeout"], true, ["-s", "-k", "--signal", "--kill-after"]), leading: 1 },
  xargs: wrapper(["xargs"], true, ["-I", "-n", "-P", "-L", "-s", "-d", "-E", "-a"]),
  nice: wrapper(["nice"], false, ["-n", "--adjustment"]),
  time: wrapper(["time"], false, ["-f", "-o", "--format", "--output"]),
  command: wrapper(["command"], false),
  builtin: wrapper(["builtin"], false),
  exec: wrapper(["exec"], false, ["-a"]),
  stdbuf: wrapper(["stdbuf"], false, ["-i", "-o", "-e"]),
};

const ASSIGNMENT = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/s;

function leadingAssignments(positionals: ReadonlyArray<Positional>): Positional[] {
  const end = positionals.findIndex((p) => !ASSIGNMENT.test(p.value));
  return positionals.slice(0, end < 0 ? positionals.length : end);
}

function assignmentEntry(word: string): [string, string] {
  const match = ASSIGNMENT.exec(word);
  return [match?.[1] ?? word, match?.[2] ?? ""];
}

function classifyWrapper(
  rule: WrapperRule,
  args: ReadonlyArray<string>,
  base: number,
): Classification {
  const parsed = parseArgs(args, new Set(rule.valueOpts), true);
  const assigns = rule.assignments ? leadingAssignments(parsed.positionals) : [];
  const rest = parsed.positionals.slice(assigns.length + rule.leading);
  const first = rest[0];
  const inner =
    first === undefined
      ? plain("exec", [])
      : classifyAt(
          rest.map((p) => p.value),
          base + first.index,
        );
  return {
    ...inner,
    kind: rule.kind === null ? inner.kind : maxKind(rule.kind, inner.kind),
    verbs: [...rule.verbs, ...inner.verbs],
    wrapped: rule.opaque || inner.wrapped,
    env: { ...Object.fromEntries(assigns.map((p) => assignmentEntry(p.value))), ...inner.env },
  };
}

const FIND_EXEC = ["-exec", "-execdir", "-ok", "-okdir"];

function findExec(args: ReadonlyArray<string>, base: number): Classification | null {
  const at = args.findIndex((a) => FIND_EXEC.includes(a));
  if (at < 0) return null;
  const end = args.findIndex((a, i) => i > at && (a === ";" || a === "+"));
  const argv = args.slice(at + 1, end < 0 ? args.length : end);
  return argv.length === 0 ? null : classifyAt(argv, base + at + 1);
}

function classifyFind(args: ReadonlyArray<string>, base: number): Classification {
  const firstExpr = args.findIndex((a) => a.startsWith("-") || a === "(" || a === "!");
  const starts = args.slice(0, firstExpr < 0 ? args.length : firstExpr);
  const deletes = args.includes("-delete");
  const inner = findExec(args, base);
  const access = deletes ? "delete" : "read";
  const own: PathArg[] = starts.map((value, i) => ({ value, index: base + i, access }));
  const innerPaths = (inner?.paths ?? []).filter((p) => !p.value.includes("{}"));
  return plain(
    maxKind(deletes ? "fs.delete" : "fs.read", inner?.kind ?? "other"),
    ["find", ...(deletes ? ["delete"] : []), ...(inner?.verbs ?? [])],
    {
      wrapped: inner !== null,
      paths: [...own, ...innerPaths],
      hosts: inner?.hosts ?? [],
      interpreter: inner?.interpreter ?? null,
    },
  );
}

function classifySubcommand(name: string, args: ReadonlyArray<string>): Classification {
  const globals = lookup(SUBCOMMAND_GLOBALS, name) ?? new Set<string>();
  const sub = parseArgs(args, globals, true).positionals[0]?.value;
  const table = lookup(SUBCOMMAND_KINDS, name);
  const kind = sub === undefined || table === undefined ? undefined : lookup(table, sub);
  return plain(kind ?? "exec", sub === undefined ? [name] : [name, sub], {
    hosts: verbHosts(name, args),
  });
}

function inlineCode(code: string): InterpreterInfo {
  return { shell: false, code, stdin: false, eval: false };
}

function classifySed(args: ReadonlyArray<string>, base: number): Classification {
  const mode = sedMode(args);
  const effects = sedEffects(args, base);
  const paths = [...effects.writes, ...filePaths("sed", args, base, mode ?? "read")];
  if (effects.code !== null)
    return plain("exec", ["sed"], { interpreter: inlineCode(effects.code), paths });
  const kind = mode === "write" ? "fs.write" : mode === "read" ? "fs.read" : "exec";
  return plain(effects.writes.length > 0 ? maxKind(kind, "fs.write") : kind, ["sed"], { paths });
}

const AWK_SHELL_OUT = /\bsystem\s*\(|\|\s*&?\s*getline|\|\s*&?\s*"/;

/** awk is a read unless its program shells out (`system()`, `cmd | getline`, `print | "cmd"`). */
function classifyAwk(args: ReadonlyArray<string>, base: number): Classification {
  const paths = filePaths("awk", args, base);
  const parsed = parseArgs(args, new Set(["-F", "-v", "-f"]));
  const program = hasOption(parsed, ["-f"]) ? undefined : parsed.positionals[0]?.value;
  if (program === undefined || !AWK_SHELL_OUT.test(program))
    return plain("fs.read", ["awk"], { paths });
  return plain("exec", ["awk"], { interpreter: inlineCode(program), paths });
}

function classifyVerb(name: string, args: ReadonlyArray<string>, base: number): Classification {
  switch (name) {
    case "git": {
      const git = readGit(args, base);
      const interpreter = git.code === null ? null : { ...inlineCode(git.code), shell: true };
      const kind = interpreter === null ? git.kind : "exec";
      return plain(kind, git.verbs, { paths: git.paths, hosts: git.hosts, interpreter });
    }
    case "curl":
    case "wget": {
      const web = name === "curl" ? readCurl(args, base) : readWget(args, base);
      return plain("net", [name], { method: web.method, hosts: web.hosts, paths: web.paths });
    }
    case "sed":
      return classifySed(args, base);
    case "rm":
      return plain("fs.delete", rmVerbs(args), { paths: filePaths("rm", args, base) });
    case "rsync": {
      const hosts = verbHosts("rsync", args);
      return plain(hosts.length > 0 ? "net" : "fs.write", ["rsync"], { hosts });
    }
    case "find":
      return classifyFind(args, base);
    case "awk":
      return classifyAwk(args, base);
  }
  if (lookup(SUBCOMMAND_KINDS, name) !== undefined) return classifySubcommand(name, args);
  return plain(lookup(VERB_KINDS, name) ?? "exec", [name], {
    paths: filePaths(name, args, base),
    hosts: verbHosts(name, args),
  });
}

function unique(values: ReadonlyArray<string>): string[] {
  return [...new Set(values)];
}

/**
 * Adds path-shaped words no rule claimed and URL hosts. A command name is an `exec`
 * path only when it contains a slash (`./x.sh`), so the `.` builtin is not a path.
 */
function withGenericArgs(
  c: Classification,
  argv: ReadonlyArray<string>,
  base: number,
): Classification {
  const claimed = new Set(c.paths.map((p) => p.index));
  const extra = argv.flatMap((value, i): PathArg[] => {
    if (claimed.has(base + i) || value.startsWith("-") || !looksLikePath(value)) return [];
    if (i === 0 && !value.includes("/")) return [];
    return [{ value, index: base + i, access: i === 0 ? "exec" : "unknown" }];
  });
  const urlHosts = argv.slice(1).map(urlHost);
  return {
    ...c,
    paths: [...c.paths, ...extra].sort((a, b) => a.index - b.index),
    hosts: unique([...c.hosts, ...urlHosts.filter((h): h is string => h !== null)]),
  };
}

function classifyAt(argv: ReadonlyArray<string>, base: number): Classification {
  if (argv.length === 0) return plain("other", []);
  const name = posix.basename(argv[0] ?? "");
  const args = argv.slice(1);
  const rule = lookup(WRAPPERS, name);
  if (rule !== undefined) return classifyWrapper(rule, args, base + 1);
  const c = classifyInterpreter(name, args, base + 1) ?? classifyVerb(name, args, base + 1);
  return withGenericArgs(c, argv, base);
}

/**
 * Classifies one argv: kind, verbs, interpreter details, and the (unresolved) paths and
 * hosts it names. Wrappers are unwrapped and keep their verbs; the command name is
 * matched on its basename. Pure: argv is never modified and nothing is resolved.
 */
export function classifyArgv(argv: ReadonlyArray<string>): Classification {
  return classifyAt(argv, 0);
}
