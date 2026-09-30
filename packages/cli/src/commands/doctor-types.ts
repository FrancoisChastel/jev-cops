/**
 * Shared shapes of `cops doctor` (PLAN-M1 §4.3–4.4): a check, and everything the doctor
 * reads from its process, injected so that tests run on a temp home with stand-in
 * binaries and never touch the real one. The doctor is read-only by design: nothing here
 * writes, and the only processes it starts are the ones it reports on.
 */

/** How one check came out; `gap` is a known bypass jev-cops cannot close (never silent). */
export type CheckStatus = "ok" | "warn" | "fail" | "gap";

/** One line of the report (plan §4.3 `Check`, plus the group it is printed under). */
export interface Check {
  readonly group: string;
  readonly name: string;
  readonly status: CheckStatus;
  readonly detail: string;
}

/** Environment variables, as a process sees them. */
export type Env = Readonly<Record<string, string | undefined>>;

/** One process to start: argv (exec form, no shell), environment, cwd, stdin, a deadline. */
export interface ProcessRequest {
  readonly argv: readonly string[];
  readonly env: Env;
  readonly cwd: string;
  readonly stdin: string;
  readonly timeoutMs: number;
}

/** What the process did; `exitCode` is null when it could not start or was killed at the deadline. */
export interface ProcessResult {
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
  /** Why it could not start, or null. */
  readonly error: string | null;
}

/** Starts a process and waits for it; never throws. */
export type ProcessRunner = (r: ProcessRequest) => Promise<ProcessResult>;

/** Which harnesses to check. */
export type HarnessChoice = "claude-code" | "pi" | "all";

/** What the doctor reads from its process; every field is injectable. */
export interface DoctorEnv {
  /** The user's home (`--home`, default `os.homedir()`): `~/.claude`, `~/.jev-cops`, `~/.pi`. */
  readonly home: string;
  /** Where the doctor runs: the project whose settings and trust are checked. */
  readonly cwd: string;
  /** The doctor's environment (`PATH`, `CLAUDE_CONFIG_DIR`, `PI_CODING_AGENT_DIR`, `JEV_COPS_*`). */
  readonly env: Env;
  readonly platform: NodeJS.Platform;
  /** Claude Code's managed-settings directory; null when the platform has none. */
  readonly managedDir: string | null;
  /** Resolves a command name on `PATH`, like exec form does; null when absent. */
  readonly which: (name: string) => string | null;
  readonly run: ProcessRunner;
}

/** A group's checks in the order they were made. */
export function check(group: string, name: string, status: CheckStatus, detail: string): Check {
  return { group, name, status, detail };
}
