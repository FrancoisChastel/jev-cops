import { hasOption, lookup, parseArgs } from "./options.ts";

/**
 * Programs besides shells and REPLs (interpreters.ts) that open a session taking commands
 * typed later, which jev-cops never sees (Codex's `write_stdin` into a running
 * `exec_command` session runs no `PreToolUse`, PLAN-M3 §2.1 row 9): editors and pagers
 * run a shell command typed at them (`:!cmd`, `!cmd`), database shells too (`\!` in psql
 * and mysql, `.shell`/`.system` in sqlite3), and `docker|podman|kubectl exec -i` hands
 * stdin to a shell in a container. Such a command gets the `interactive-shell` verb.
 * Over-inclusive on purpose, like the REPL list.
 */

/** Editors: `:!cmd` (the vi family, `ex`), `M-!` (emacs), ^T (nano). */
export const EDITORS = ["vi", "vim", "nvim", "view", "vimdiff", "ex", "emacs", "nano"] as const;

/**
 * Pagers and `man` (which pages): `!cmd` runs a shell command while their output is the
 * terminal. command.ts drops the verb when the output goes to a pipe or a file, where a
 * pager only copies its input.
 */
export const PAGERS = ["less", "more", "most", "man"] as const;

/** Flags after which the program only prints and exits. */
const PRINT_ONLY: Readonly<Record<string, ReadonlyArray<string>>> = {
  man: ["--version", "--help", "-k", "-f", "-w", "--apropos", "--whatis", "--where", "--path"],
};
const INFO_FLAGS = ["--version", "--help"];

/** psql and mysql: the flags that run a command (or print) and exit instead of a session. */
const DB_COMMAND_FLAGS: Readonly<Record<string, ReadonlyArray<string>>> = {
  psql: ["-c", "--command", "-f", "--file", "-l", "--list", "-V", "--version", "--help", "-?"],
  mysql: ["-e", "--execute", "-V", "--version", "--help", "-?"],
  mariadb: ["-e", "--execute", "-V", "--version", "--help", "-?"],
};

/** sqlite3 options (one or two dashes) and how many values each takes. */
const SQLITE_VALUES: Readonly<Record<string, number>> = {
  ...{ "-cmd": 1, "-init": 1, "-separator": 1, "-newline": 1, "-nullvalue": 1, "-vfs": 1 },
  ...{ "-maxsize": 1, "-mmap": 1, "-heap": 1, "-A": 1, "-lookaside": 2, "-pagecache": 2 },
};
const SQLITE_INFO = ["-version", "-help"];

/** How a container CLI's `exec` reads: global options, the subcommand, its own options. */
interface ExecCli {
  globals: ReadonlySet<string>;
  subcommands: ReadonlyArray<ReadonlyArray<string>>;
  values: ReadonlySet<string>;
  stdin: ReadonlyArray<string>;
  /** docker: everything after the container is its command; kubectl: after `--`. */
  commandAfterTarget: boolean;
}

const DOCKER_GLOBALS = ["-H", "--host", "--config", "--context", "-c", "-l", "--log-level"];
const DOCKER_EXEC: ExecCli = {
  globals: new Set(DOCKER_GLOBALS),
  subcommands: [["exec"], ["container", "exec"]],
  values: new Set(["-e", "--env", "--env-file", "-u", "--user", "-w", "--workdir"]),
  stdin: ["-i", "--interactive"],
  commandAfterTarget: true,
};
const KUBECTL_GLOBALS = ["-n", "--namespace", "--context", "--kubeconfig", "--cluster"].concat([
  "--user",
  "-s",
  "--server",
  "--token",
  "--as",
  "--request-timeout",
]);
const KUBECTL_EXEC: ExecCli = {
  globals: new Set(KUBECTL_GLOBALS),
  subcommands: [["exec"]],
  values: new Set([...KUBECTL_GLOBALS, "-c", "--container", "-f", "--filename"]),
  stdin: ["-i", "--stdin"],
  commandAfterTarget: false,
};
const CONTAINER_EXEC: Readonly<Record<string, ExecCli>> = {
  docker: DOCKER_EXEC,
  podman: DOCKER_EXEC,
  kubectl: KUBECTL_EXEC,
};

/** Classifies a command a container runs: true when it opens a session itself. */
export type InnerSession = (argv: ReadonlyArray<string>) => boolean;

function oneOf(list: ReadonlyArray<string>, name: string): boolean {
  return list.includes(name);
}

/** `-cSQL` and `--command=SQL` name `-c` and `--command` too. */
function namesFlag(arg: string, flag: string): boolean {
  if (arg === flag || arg.startsWith(`${flag}=`)) return true;
  return flag.length === 2 && !arg.startsWith("--") && arg.startsWith(flag);
}

function sqlitePositionals(args: ReadonlyArray<string>): string[] {
  const start = { skip: 0, out: [] as string[] };
  return args.reduce((acc, arg) => {
    if (acc.skip > 0) return { skip: acc.skip - 1, out: acc.out };
    if (arg.length < 2 || !arg.startsWith("-")) return { skip: 0, out: [...acc.out, arg] };
    return { skip: lookup(SQLITE_VALUES, arg.replace(/^--/, "-")) ?? 0, out: acc.out };
  }, start).out;
}

/** `sqlite3 [options] [db [sql…]]`: a session unless it is given SQL (or a dot-command). */
function sqliteSession(args: ReadonlyArray<string>): boolean {
  if (args.some((a) => oneOf(SQLITE_INFO, a.replace(/^--/, "-")))) return false;
  return sqlitePositionals(args).length < 2;
}

/** The argument list after the CLI's `exec` subcommand, or null when it runs another one. */
function afterSubcommand(cli: ExecCli, args: ReadonlyArray<string>): ReadonlyArray<string> | null {
  const head = parseArgs(args, cli.globals, true).positionals;
  const sub = cli.subcommands.find((words) => words.every((w, i) => head[i]?.value === w));
  const last = sub === undefined ? undefined : head[sub.length - 1];
  return last === undefined ? null : args.slice(last.index + 1);
}

/** `exec -i <target> [command…]`: stdin reaches the container, and no command or a session. */
function execSession(cli: ExecCli, args: ReadonlyArray<string>, inner: InnerSession): boolean {
  const rest = afterSubcommand(cli, args);
  if (rest === null) return false;
  const parsed = parseArgs(rest, cli.values, cli.commandAfterTarget);
  const command = parsed.positionals.slice(1).map((p) => p.value);
  return hasOption(parsed, cli.stdin) && (command.length === 0 || inner(command));
}

/**
 * True when `name args…` opens a session that takes commands typed later: an editor or a
 * pager (unless it only prints its version, help or a `man` lookup), psql or mysql
 * without a command to run, sqlite3 without SQL, or a container `exec -i` into a session.
 * `inner` classifies the command a container runs.
 */
export function opensSession(
  name: string,
  args: ReadonlyArray<string>,
  inner: InnerSession,
): boolean {
  if (oneOf(EDITORS, name) || oneOf(PAGERS, name)) {
    const printOnly = lookup(PRINT_ONLY, name) ?? INFO_FLAGS;
    return !args.some((a) => oneOf(printOnly, a));
  }
  const commandFlags = lookup(DB_COMMAND_FLAGS, name);
  if (commandFlags !== undefined) {
    return !args.some((a) => commandFlags.some((f) => namesFlag(a, f)));
  }
  if (name === "sqlite3") return sqliteSession(args);
  const exec = lookup(CONTAINER_EXEC, name);
  return exec !== undefined && execSession(exec, args, inner);
}
