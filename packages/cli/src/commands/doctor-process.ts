/**
 * The real process side of `cops doctor`: a {@link ProcessRunner} over `Bun.spawn` (exec
 * form, no shell, stdin from a string, killed at its deadline) and the default
 * {@link DoctorEnv} of this process. Tests inject their own.
 */
import { homedir } from "node:os";
import { managedDirFor } from "@jev-cops/adapter-claude-code";
import type {
  DoctorEnv,
  Env,
  ProcessRequest,
  ProcessResult,
  ProcessRunner,
} from "./doctor-types.ts";

/** `env` without unset variables, as `Bun.spawn` wants it. */
function defined(env: Env): Record<string, string> {
  return Object.fromEntries(
    Object.entries(env).filter((e): e is [string, string] => e[1] !== undefined),
  );
}

function failedToStart(cause: unknown): ProcessResult {
  const error = cause instanceof Error ? cause.message : String(cause);
  return { exitCode: null, stdout: "", stderr: "", timedOut: false, error };
}

/** Starts `r.argv` and waits for it, killing it (SIGKILL) at `r.timeoutMs`. Never throws. */
export const spawnProcess: ProcessRunner = async (r: ProcessRequest) => {
  let proc: Bun.Subprocess<Blob, "pipe", "pipe">;
  try {
    proc = Bun.spawn([...r.argv], {
      cwd: r.cwd,
      env: defined(r.env),
      stdin: new Blob([r.stdin]),
      stdout: "pipe",
      stderr: "pipe",
    });
  } catch (cause) {
    return failedToStart(cause);
  }
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

/** The doctor's view of this process: its home, cwd, environment, platform and `PATH`. */
export function processDoctorEnv(overrides: Partial<Pick<DoctorEnv, "home">> = {}): DoctorEnv {
  const env = process.env;
  return {
    home: overrides.home ?? homedir(),
    cwd: process.cwd(),
    env,
    platform: process.platform,
    managedDir: managedDirFor(process.platform),
    which: (name) => Bun.which(name, { PATH: env.PATH ?? "" }),
    run: spawnProcess,
  };
}
