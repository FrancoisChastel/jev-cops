/**
 * One child process with a deadline, never throwing: how the installer runs the hook
 * binary (`--version`, the offline canary) and `claude --version`. Injected everywhere so
 * tests can stand in for any program.
 */
import { isAbsolute } from "node:path";

/** What to run: argv (a bare `argv[0]` is looked up on `env.PATH`), environment, stdin. */
export interface SpawnRequest {
  readonly argv: readonly string[];
  readonly env: Readonly<Record<string, string>>;
  readonly cwd?: string;
  readonly stdin?: string;
  readonly timeoutMs: number;
}

/** What came back; `exitCode` is null when it could not start or was killed at the deadline. */
export interface SpawnResult {
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
  /** Why it could not start, or null. */
  readonly error: string | null;
}

/** Runs one process. */
export type Spawn = (r: SpawnRequest) => Promise<SpawnResult>;

function failed(error: string): SpawnResult {
  return { exitCode: null, stdout: "", stderr: "", timedOut: false, error };
}

function resolveCommand(command: string, env: Readonly<Record<string, string>>): string | null {
  if (command.includes("/") || isAbsolute(command)) return command;
  return Bun.which(command, { PATH: env.PATH ?? "" });
}

/** {@link Spawn} with `Bun.spawn`: SIGKILL at the deadline, output read to the end. */
export const spawnProcess: Spawn = async (r) => {
  const [command = "", ...args] = r.argv;
  const resolved = resolveCommand(command, r.env);
  if (resolved === null) return failed(`${command}: not found on PATH`);
  let proc: Bun.Subprocess<"pipe", "pipe", "pipe">;
  try {
    proc = Bun.spawn([resolved, ...args], {
      env: { ...r.env },
      ...(r.cwd === undefined ? {} : { cwd: r.cwd }),
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
  } catch (cause) {
    return failed(cause instanceof Error ? cause.message : String(cause));
  }
  proc.stdin.write(r.stdin ?? "");
  await proc.stdin.end();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    proc.kill("SIGKILL");
  }, r.timeoutMs);
  const [code, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  clearTimeout(timer);
  return { exitCode: timedOut ? null : code, stdout, stderr, timedOut, error: null };
};
