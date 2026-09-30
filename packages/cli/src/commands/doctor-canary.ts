/**
 * The offline canary of `cops doctor` (PLAN-M1 §4.4, D-091, D-092). The canary itself (the
 * two synthetic `PreToolUse` payloads, what each must answer, and how a run is classified)
 * is the adapter's `runOfflineCanary` (adapters/claude-code/src/canary.ts), the one
 * `cops install claude-code` runs. This module only runs it through one registered hook with
 * the doctor's process runner, and renders each probe as a check:
 * ok → ok, observe → warn (the hook cannot block, by design), unreachable → fail with a
 * hint, failed → fail ("gate silently disabled" when the config write got through).
 * The config write targets copsd's home (`[daemon] home`), the one `config-tamper` protects;
 * the hook runs with the user's HOME, in the project, under the registered timeout.
 */
import { basename } from "node:path";
import {
  type CanaryProbe,
  type CanaryResult,
  runOfflineCanary,
  type Spawn,
} from "@jev-cops/adapter-claude-code";
import {
  type Check,
  type CheckStatus,
  check,
  type Env,
  type ProcessRunner,
} from "./doctor-types.ts";

/** The hook as registered: `command` and `args`, and the settings `timeout` in seconds. */
export interface CanaryHook {
  readonly command: string;
  readonly args: readonly string[];
  readonly timeoutS?: number;
}

/** What one doctor canary run needs. */
export interface DoctorCanaryOptions {
  readonly hook: CanaryHook;
  /** The user's home: the hook's HOME. */
  readonly home: string;
  /** copsd's home: the config write targets `<daemonHome>/.claude/settings.json`. */
  readonly daemonHome: string;
  /** The payloads' `cwd` and the hook's working directory. */
  readonly cwd: string;
  /** The doctor's environment (only `PATH` reaches the hook, with `HOME`). */
  readonly env: Env;
  readonly run: ProcessRunner;
}

/** The benign probe's check name. */
export const BENIGN_CASE = "benign call proceeds";
/** The config-write probe's check name. */
export const CONFIG_WRITE_CASE = "config write is killed";
/** Claude Code's registered PreToolUse timeout when the entry names none. */
const DEFAULT_TIMEOUT_S = 30;
const OBSERVE_NOTE = "enforcement observe: the hook cannot block, by design";

/** Runs the shared canary through `o.hook`, as Claude Code would spawn it. Never throws. */
export function doctorCanary(o: DoctorCanaryOptions): Promise<CanaryResult> {
  const spawn: Spawn = (r) =>
    o.run({
      argv: r.argv,
      env: r.env,
      cwd: r.cwd ?? o.cwd,
      stdin: r.stdin ?? "",
      timeoutMs: r.timeoutMs,
    });
  return runOfflineCanary({
    hook: { command: o.hook.command, args: o.hook.args },
    home: o.home,
    targetHome: o.daemonHome,
    cwd: o.cwd,
    env: o.env,
    timeoutMs: (o.hook.timeoutS ?? DEFAULT_TIMEOUT_S) * 1_000,
    spawn,
  });
}

function firstLine(text: string): string {
  return text.trim().split("\n")[0] ?? "";
}

function statusOf(p: CanaryProbe): CheckStatus {
  if (p.outcome === "ok") return "ok";
  return p.outcome === "observe" ? "warn" : "fail";
}

function failedDetail(p: CanaryProbe, why: string): string {
  if (p.name === "benign-bash") return `A benign call did not pass cleanly${why}`;
  const through = p.exitCode !== null && p.exitCode !== 2;
  const lead = through
    ? "The hook let a config write through: gate silently disabled"
    : "The hook did not block as expected";
  return `${lead}${why}`;
}

/** Why a probe came out the way it did, for a human. */
function explain(p: CanaryProbe): string {
  const line = firstLine(p.stderr);
  const why = line === "" ? "" : ` (${line})`;
  switch (p.outcome) {
    case "ok":
      return p.name === "benign-bash"
        ? "A benign call proceeds with no output"
        : "The hook ran, copsd answered, config-tamper killed the write, and the kill ends the turn";
    case "observe":
      return `${OBSERVE_NOTE} (copsd returned what it would have done)`;
    case "unreachable":
      return `The hook could not reach copsd${why}, so it blocks every non-read call (fail closed): check its --socket, start copsd and re-run`;
    case "failed":
      return failedDetail(p, why);
  }
}

/** The canary's probes as report lines, in the order they ran. */
export function canaryChecks(result: CanaryResult, hook: CanaryHook): Check[] {
  return result.probes.map((p) => {
    const name = p.name === "benign-bash" ? BENIGN_CASE : CONFIG_WRITE_CASE;
    const detail = `via ${basename(hook.command)}: expected ${p.expected}; observed ${p.observed}. ${explain(p)}`;
    return check("canary", name, statusOf(p), detail);
  });
}
