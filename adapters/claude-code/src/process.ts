/**
 * The hook process around {@link runHook}: the fail-closed shell (PLAN-M1 §5 rows 2–3).
 * The exit code is 2 before any work, so a crash, an unhandled rejection or an early exit
 * blocks (Claude Code treats every code but 2 as "proceed"); stdin is read under the
 * deadline; stdout and stderr are written synchronously, then the process exits with the
 * outcome's code. Shared by `dist/jevdict-hook` and `jevdict hook`.
 */
import { writeSync } from "node:fs";
import { homedir } from "node:os";
import { parseHookArgs } from "./args.ts";
import { createClient } from "./client.ts";
import { deadlinesFrom, type HookDeps } from "./deps.ts";
import { runHook, withDeadline } from "./hook.ts";
import { appendHookLog, type HookLogLine, hookLogPath } from "./log.ts";
import { detectMode, readProc } from "./mode.ts";
import { failClosed, type HookOutput } from "./output.ts";
import { readHarnessVersion } from "./state.ts";

/** What the hook needs from its process; tests pass a recording double. */
export interface HookPort {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly home: string;
  /** The hook's parent (Claude Code in exec form), for the session mode. */
  readonly ppid: number;
  readStdin(): Promise<string>;
  write(fd: 1 | 2, text: string): void;
  exit(code: 0 | 2): void;
  /** Registers the handler for uncaught exceptions and unhandled rejections. */
  onFatal(handler: (why: string) => void): void;
  setExitCode(code: number): void;
}

/** How this process was started: the executable and the argv before the hook's flags. */
export interface HookSelf {
  readonly command: string;
  readonly leading: readonly string[];
}

const EAGAIN_PAUSE_MS = 1;

function message(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/** Writes all of `text` to `fd` synchronously (an async write can be cut by `process.exit`). */
export function writeAll(fd: number, text: string): void {
  const bytes = Buffer.from(text);
  let offset = 0;
  while (offset < bytes.length) {
    try {
      offset += writeSync(fd, bytes, offset);
    } catch (cause) {
      if ((cause as { code?: string }).code !== "EAGAIN") throw cause;
      Bun.sleepSync(EAGAIN_PAUSE_MS);
    }
  }
}

/** The real process as a {@link HookPort}. */
export function processPort(): HookPort {
  return {
    env: process.env,
    home: homedir(),
    ppid: process.ppid,
    readStdin: () => Bun.stdin.text(),
    write: (fd, text) => writeAll(fd, text),
    exit: (code) => process.exit(code),
    onFatal: (handler) => {
      process.on("uncaughtException", (e) => handler(`hook crashed (${message(e)})`));
      process.on("unhandledRejection", (e) => handler(`hook crashed (${message(e)})`));
    },
    setExitCode: (code) => {
      process.exitCode = code;
    },
  };
}

/**
 * The identity of this hook process: from source, `bun` plus the entry script; compiled,
 * the binary alone (`Bun.main` is then under `/$bunfs/`). `subcommand` is what precedes the
 * flags (`["hook"]` for `jevdict hook`).
 */
export function selfOf(
  subcommand: readonly string[],
  runtime: { execPath: string; main: string } = { execPath: process.execPath, main: Bun.main },
): HookSelf {
  const compiled = runtime.main.startsWith("/$bunfs/") || runtime.main.startsWith("B:/~BUN/");
  const leading = compiled ? [...subcommand] : [runtime.main, ...subcommand];
  return { command: runtime.execPath, leading };
}

function once<T>(read: () => T): () => T {
  let cached: { value: T } | null = null;
  return () => {
    cached ??= { value: read() };
    return cached.value;
  };
}

function depsFor(socket: string, port: HookPort): HookDeps {
  const logPath = hookLogPath(port.home);
  const log = (line: HookLogLine) => {
    try {
      appendHookLog(logPath, line, new Date());
    } catch (cause) {
      port.write(2, `jevdict: local log not written (${message(cause)})\n`);
    }
  };
  return {
    client: createClient(socket),
    deadlines: deadlinesFrom(port.env),
    mode: once(() => detectMode(port.ppid, (pid) => readProc(pid))),
    harnessVersion: once(() => readHarnessVersion(port.home)),
    log,
  };
}

function emit(out: HookOutput, port: HookPort): 0 | 2 {
  if (out.stdout !== null) port.write(1, `${out.stdout}\n`);
  if (out.stderr !== null) port.write(2, `${out.stderr}\n`);
  port.exit(out.exitCode);
  return out.exitCode;
}

async function outcome(argv: readonly string[], port: HookPort): Promise<HookOutput> {
  const args = parseHookArgs(argv, port.home);
  if (!args.ok) return failClosed(`jevdict hook: ${args.error}; blocking (fail closed)`);
  const deps = depsFor(args.socket, port);
  const stdin = await withDeadline<string | null>(
    port.readStdin(),
    deps.deadlines.judgeMs,
    () => null,
  );
  if (stdin === null) {
    return failClosed("unreadable hook payload (stdin not closed); blocking (fail closed)");
  }
  return runHook(stdin, deps);
}

/**
 * Runs the hook as this process: exit code 2 first, fatal handlers, arguments, stdin, the
 * run, the output, the exit. `_self` is how the process was started (see {@link selfOf}).
 * Resolves with the exit code (the real port has exited by then).
 */
export async function runHookProcess(
  argv: readonly string[],
  _self: readonly string[],
  port: HookPort = processPort(),
): Promise<0 | 2> {
  port.setExitCode(2);
  port.onFatal((why) => {
    port.write(2, `jevdict: ${why}; blocking (fail closed)\n`);
    port.exit(2);
  });
  try {
    return emit(await outcome(argv, port), port);
  } catch (cause) {
    return emit(failClosed(`hook error (${message(cause)}); blocking (fail closed)`), port);
  }
}
