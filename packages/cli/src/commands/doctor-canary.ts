/**
 * The offline canary of `cops doctor` (PLAN-M1 §4.4, D-078 proposal): the hook is spawned
 * exactly as the effective settings register it (command + args, exec form, no shell) and
 * fed two synthetic `PreToolUse` payloads, each under its own throw-away session:
 * - a `Write` to `<home>/.claude/settings.json` (home = copsd's), expected exit 2 with a JSON
 *   `deny` and `continue: false`: the binary runs, copsd answers, `config-tamper` is loaded
 *   and `kill` is mapped. In `observe` mode the hook cannot block, by design: exit 0 with
 *   copsd's "would have" note as `additionalContext`;
 * - a `Bash` `true`, expected exit 0 and no output.
 * Nothing is executed: the hook only judges. The kill latches the throw-away session in copsd.
 *
 * The runner sits behind {@link CanaryRunner} so the adapter's shared `runOfflineCanary`
 * (adapters/claude-code/src/canary.ts, from `cops install`) can replace it; the result shape
 * is the shared one.
 */
import { randomUUID } from "node:crypto";
import { basename, join } from "node:path";
import {
  type Check,
  type CheckStatus,
  check,
  type Env,
  type ProcessResult,
  type ProcessRunner,
} from "./doctor-types.ts";

/** The hook as registered: `command` and `args`, and the settings `timeout` in seconds. */
export interface CanaryHook {
  readonly command: string;
  readonly args: readonly string[];
  readonly timeoutS?: number;
}

/** What one canary run needs. */
export interface CanaryOptions {
  readonly hook: CanaryHook;
  /** copsd's home: the config write targets `<home>/.claude/settings.json`. */
  readonly home: string;
  /** The payloads' `cwd` and the hook's working directory. */
  readonly cwd: string;
  /** The hook's environment (Claude Code passes its own through). */
  readonly env: Env;
  /** copsd's enforcement mode (`/v1/health`); null when unknown (enforce is expected). */
  readonly enforcement: "observe" | "enforce" | null;
  readonly run: ProcessRunner;
}

/**
 * One case. `expected` and `observed` use one vocabulary (`exit 2, deny, continue:false`,
 * `exit 0, no output`, `timed out`, `did not start`, …): a case passed iff they are equal.
 */
export interface CanaryCase {
  readonly name: string;
  readonly exitCode: number | null;
  readonly expected: string;
  readonly observed: string;
  readonly detail: string;
}

/** Every case, and whether all of them passed. */
export interface CanaryResult {
  readonly ok: boolean;
  readonly cases: readonly CanaryCase[];
}

/** Runs the canary through one registered hook; never throws. */
export type CanaryRunner = (o: CanaryOptions) => Promise<CanaryResult>;

/** The config-write case's name. */
export const CONFIG_WRITE_CASE = "config write is killed";
/** The benign case's name. */
export const BENIGN_CASE = "benign call proceeds";
/** Claude Code's registered PreToolUse timeout when the entry names none. */
const DEFAULT_TIMEOUT_S = 30;
const OBSERVE_NOTE = "enforcement observe: the hook cannot block, by design";

function payload(id: string, cwd: string, tool: string, input: Record<string, unknown>): string {
  return JSON.stringify({
    session_id: `jev-cops-doctor-${id}`,
    cwd,
    permission_mode: "default",
    hook_event_name: "PreToolUse",
    tool_name: tool,
    tool_input: input,
    tool_use_id: `toolu_doctor_${id}`,
  });
}

function jsonOf(text: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(text);
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function jsonParts(json: Record<string, unknown>): string[] {
  const hso = (json.hookSpecificOutput ?? {}) as Record<string, unknown>;
  const parts = [
    ...(typeof hso.permissionDecision === "string" ? [hso.permissionDecision] : []),
    ...(hso.additionalContext === undefined ? [] : ["additionalContext"]),
    ...(hso.updatedInput === undefined ? [] : ["updatedInput"]),
    ...(json.continue === false ? ["continue:false"] : []),
  ];
  return parts.length === 0 ? ["other JSON"] : parts;
}

/** What a hook run did, as Claude Code reads it (exit code, then the JSON decision). */
export function describeRun(r: ProcessResult): string {
  if (r.error !== null) return "did not start";
  if (r.timedOut) return "timed out";
  const out = r.stdout.trim();
  const json = out === "" ? null : jsonOf(out);
  const rest = out === "" ? ["no output"] : json === null ? ["non-JSON output"] : jsonParts(json);
  return [`exit ${r.exitCode}`, ...rest].join(", ");
}

function firstLine(text: string): string {
  return text.trim().split("\n")[0] ?? "";
}

function writeDetail(passed: boolean, observe: boolean, r: ProcessResult): string {
  if (passed) {
    return observe
      ? `${OBSERVE_NOTE} (copsd returned what it would have done)`
      : "The hook ran, copsd answered, config-tamper killed the write, and the kill ends the turn";
  }
  const through = r.error === null && !r.timedOut && r.exitCode !== 2;
  const why = firstLine(r.error ?? r.stderr);
  const lead = through
    ? "The hook let a config write through: gate silently disabled"
    : "The hook did not block as expected";
  return why === "" ? lead : `${lead} (${why})`;
}

function benignDetail(passed: boolean, r: ProcessResult): string {
  if (passed) return "A benign call proceeds with no output";
  const why = firstLine(r.error ?? r.stderr);
  return `A benign call did not pass cleanly${why === "" ? "" : ` (${why})`}`;
}

async function spawnCase(o: CanaryOptions, stdin: string): Promise<ProcessResult> {
  const timeoutMs = (o.hook.timeoutS ?? DEFAULT_TIMEOUT_S) * 1_000;
  return o.run({
    argv: [o.hook.command, ...o.hook.args],
    env: o.env,
    cwd: o.cwd,
    stdin,
    timeoutMs,
  });
}

/** The doctor's own canary runner (see the module comment). */
export const offlineCanary: CanaryRunner = async (o) => {
  const nonce = randomUUID();
  const observe = o.enforcement === "observe";
  const target = join(o.home, ".claude", "settings.json");
  const write = await spawnCase(
    o,
    payload(`${nonce}-write`, o.cwd, "Write", { file_path: target, content: "{}" }),
  );
  const benign = await spawnCase(o, payload(`${nonce}-bash`, o.cwd, "Bash", { command: "true" }));
  const expectWrite = observe ? "exit 0, additionalContext" : "exit 2, deny, continue:false";
  const cases = [
    { name: CONFIG_WRITE_CASE, run: write, expected: expectWrite },
    { name: BENIGN_CASE, run: benign, expected: "exit 0, no output" },
  ].map(({ name, run, expected }) => {
    const observed = describeRun(run);
    const passed = observed === expected;
    const detail =
      name === CONFIG_WRITE_CASE ? writeDetail(passed, observe, run) : benignDetail(passed, run);
    return { name, exitCode: run.exitCode, expected, observed, detail };
  });
  return { ok: cases.every((c) => c.expected === c.observed), cases };
};

/** The canary's cases as report lines; in observe mode a passing config write is a warning. */
export function canaryChecks(
  result: CanaryResult,
  hook: CanaryHook,
  enforcement: "observe" | "enforce" | null,
): Check[] {
  return result.cases.map((c) => {
    const passed = c.expected === c.observed;
    const status: CheckStatus = !passed
      ? "fail"
      : enforcement === "observe" && c.name === CONFIG_WRITE_CASE
        ? "warn"
        : "ok";
    const detail = `via ${basename(hook.command)}: expected ${c.expected}; observed ${c.observed}. ${c.detail}`;
    return check("canary", c.name, status, detail);
  });
}
