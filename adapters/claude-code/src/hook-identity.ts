/**
 * Which hook a registered Claude Code entry starts, and whether that is this hook (D-087).
 * One definition for everyone who must agree on it: the hook describes itself with
 * {@link selfOf}; the ConfigChange check (intact.ts) matches entries with
 * {@link selfFlags}; the installer's post-install check (install.ts) and `cops doctor`
 * predict, with {@link entrySelf}, the identity a hook started by an entry will compute;
 * uninstall ownership (hook-entries.ts) unwraps `bun <script>` with {@link namedProgram}.
 *
 * A hook is its **program**, the file whose code runs, symlinks resolved: a compiled binary
 * (`dist/cops-hook`), or the script Bun runs (`jev-cops/bin/cops-hook.ts`, the adapter's
 * `hook-main.ts`, the CLI's `main.ts`). An exec-form entry starts program P either
 * **directly** (`command` resolves to P: a compiled binary, or a script run through its
 * `#!/usr/bin/env bun` line, which is how `cops install` registers the npm install), or
 * **through Bun** (`command` resolves to the very Bun running the hook and `args[0]` to P).
 * Then come the leading arguments (`hook` for `cops hook`), then the hook's own flags.
 * Nothing looser counts: another binary, another script, another Bun, or a wrapper that
 * execs the hook is not this hook.
 */
import { closeSync, openSync, readSync, realpathSync } from "node:fs";
import { basename, resolve } from "node:path";

/** How a Bun process was started: `process.execPath` and `Bun.main`. */
export interface HookRuntime {
  readonly execPath: string;
  readonly main: string;
}

/** A hook as it runs: its program, the Bun running it (none when compiled), its leading args. */
export interface HookSelf {
  /** The file whose code runs: the compiled binary, or the entry script. */
  readonly program: string;
  /** The Bun executable running `program` from source; null for a compiled binary. */
  readonly runtime: string | null;
  /** The arguments before the hook's flags: `["hook"]` for `cops hook`, else none. */
  readonly leading: readonly string[];
}

/** Where an exec-form command's names resolve: `${CLAUDE_PROJECT_DIR}` and relative paths, and `PATH`. */
export interface ExecContext {
  readonly projectDir: string;
  readonly path: string;
}

/** Executable names of Bun itself (an entry `bun <script>` runs `<script>`). */
const BUN_NAMES: ReadonlySet<string> = new Set(["bun", "bun.exe"]);
/** A `#!` line naming Bun directly (`#!/…/bun`) or through `env` (`#!/usr/bin/env [-S] bun`). */
const SHEBANG = /^#!\s*(\S+)(?:\s+(?:-S\s+)?(\S+))?/;
const SHEBANG_BYTES = 256;

/** True when `main` (`Bun.main`) is inside a compiled executable. */
export function isCompiledMain(main: string): boolean {
  return main.startsWith("/$bunfs/") || main.startsWith("B:/~BUN/");
}

/**
 * This process as a hook: compiled, the binary itself; from source, the entry script run
 * by `process.execPath`. `subcommand` precedes the hook's flags (`["hook"]` for `cops hook`).
 */
export function selfOf(
  subcommand: readonly string[],
  runtime: HookRuntime = { execPath: process.execPath, main: Bun.main },
): HookSelf {
  if (isCompiledMain(runtime.main)) {
    return { program: runtime.execPath, runtime: null, leading: [...subcommand] };
  }
  return { program: runtime.main, runtime: runtime.execPath, leading: [...subcommand] };
}

/** `path` with every symlink resolved, or null when it does not exist or cannot be read. */
export function realpathOrNull(path: string | null | undefined): string | null {
  if (path === null || path === undefined || path === "") return null;
  try {
    return realpathSync(path);
  } catch {
    return null; // missing or unreadable: never the same file as anything
  }
}

/** The real file an exec-form `command` spawns (placeholder substituted, bare names on `PATH`). */
export function commandFile(command: string, ctx: ExecContext): string | null {
  // biome-ignore lint/suspicious/noTemplateCurlyInString: Claude Code's literal placeholder
  const expanded = command.replaceAll("${CLAUDE_PROJECT_DIR}", ctx.projectDir);
  if (expanded.includes("/")) return realpathOrNull(resolve(ctx.projectDir, expanded));
  return realpathOrNull(Bun.which(expanded, { PATH: ctx.path }));
}

function argFile(arg: string, ctx: ExecContext): string | null {
  return realpathOrNull(resolve(ctx.projectDir, arg));
}

function sameArg(entry: string | undefined, mine: string, ctx: ExecContext): boolean {
  if (entry === undefined) return false;
  if (entry === mine) return true;
  const a = argFile(entry, ctx);
  return a !== null && a === realpathOrNull(mine);
}

/**
 * The flags an exec-form entry passes to `self` (what follows its program and leading
 * arguments), or null when the entry starts anything else (see the module doc).
 */
export function selfFlags(
  command: string,
  args: readonly string[],
  self: HookSelf,
  ctx: ExecContext,
): readonly string[] | null {
  const file = commandFile(command, ctx);
  const program = realpathOrNull(self.program);
  if (file === null || program === null) return null;
  const rest = afterProgram(file, program, args, self, ctx);
  if (rest === null) return null;
  if (!self.leading.every((mine, k) => sameArg(rest[k], mine, ctx))) return null;
  return rest.slice(self.leading.length);
}

/** `args` after the program: all of them when `file` is it, else past the script under this Bun. */
function afterProgram(
  file: string,
  program: string,
  args: readonly string[],
  self: HookSelf,
  ctx: ExecContext,
): readonly string[] | null {
  if (file === program) return args;
  const script = args[0];
  if (script === undefined || file !== realpathOrNull(self.runtime)) return null;
  return argFile(script, ctx) === program ? args.slice(1) : null;
}

/** The Bun a script's `#!` line runs (`env bun` on `PATH`, or an absolute bun), or null. */
function shebangRuntime(file: string, ctx: ExecContext): string | null {
  let head = "";
  try {
    const fd = openSync(file, "r");
    try {
      const buf = Buffer.alloc(SHEBANG_BYTES);
      head = buf.subarray(0, readSync(fd, buf, 0, SHEBANG_BYTES, 0)).toString("latin1");
    } finally {
      closeSync(fd);
    }
  } catch {
    return null; // unreadable: no runtime to predict
  }
  const m = SHEBANG.exec(head.split("\n")[0] ?? "");
  if (m === null) return null;
  const [interpreter, arg] = [m[1] ?? "", m[2]];
  if (BUN_NAMES.has(basename(interpreter))) return realpathOrNull(interpreter);
  if (basename(interpreter) === "env" && arg !== undefined && BUN_NAMES.has(arg)) {
    return realpathOrNull(Bun.which(arg, { PATH: ctx.path }));
  }
  return null;
}

/** True when `file` is a Bun executable (by name: the entry then runs `args[0]`). */
export function isBunExecutable(file: string): boolean {
  return BUN_NAMES.has(basename(file).toLowerCase());
}

/**
 * The program an entry names, without touching the file system: `args[0]` under
 * `bun`, else `command`. For ownership tests (uninstall), not for "intact".
 */
export function namedProgram(command: string, args: readonly string[]): string {
  const script = args[0];
  return isBunExecutable(command) && script !== undefined ? script : command;
}

/** What {@link entrySelf} predicts: the hook's identity and the flags the entry passes it. */
export interface EntrySelf {
  readonly self: HookSelf;
  readonly flags: readonly string[];
}

/**
 * The {@link HookSelf} a hook started by this entry computes, and the flags it gets; null
 * when the command resolves to no file. The leading arguments are those before the first
 * `-`-prefixed one (the hook's flags all are). Used by the installer and `cops doctor`, so
 * their "intact" is the one the hook will compute (the `bun` runtime of a script started
 * directly is the one its `#!` line finds on `PATH`).
 */
export function entrySelf(
  command: string,
  args: readonly string[],
  ctx: ExecContext,
): EntrySelf | null {
  const file = commandFile(command, ctx);
  if (file === null) return null;
  const viaBun = isBunExecutable(file) && args[0] !== undefined;
  const program = viaBun ? argFile(args[0] ?? "", ctx) : file;
  if (program === null) return null;
  const rest = viaBun ? args.slice(1) : args;
  const at = rest.findIndex((a) => a.startsWith("-"));
  const cut = at < 0 ? rest.length : at;
  const runtime = viaBun ? file : shebangRuntime(file, ctx);
  return { self: { program, runtime, leading: rest.slice(0, cut) }, flags: rest.slice(cut) };
}
