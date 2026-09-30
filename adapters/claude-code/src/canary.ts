/**
 * The offline canary (PLAN-M1 §4.4, D-091): spawn the hook exactly as the settings register
 * it (command + args, exec form) with two synthetic `PreToolUse` payloads under throw-away
 * sessions, and check what it answers:
 * - `Bash` `true` → exit 0, empty stdout (the binary runs, the daemon answers, allow maps
 *   to "no decision");
 * - `Write` to `<copsd home>/.claude/settings.json` → exit 2 with a JSON deny and
 *   `continue: false` (config-tamper is loaded and `kill` is mapped). In `observe` mode it
 *   exits 0 with the "would have: kill" note instead.
 * - with `config`, a `ConfigChange` for a settings file that did not change → exit 0, no
 *   output: the hook's own intact check (intact.ts, from the identity the hook computes for
 *   itself, hook-identity.ts) finds itself registered on every required event. A hook that
 *   does not would block every settings change and latch the session (the Docker e2e's F1,
 *   while `cops doctor`'s own reading said "registered").
 * A daemon that is down or too slow makes every call fail closed ("unreachable"). The one
 * source of truth for the payloads and expectations: `cops install claude-code` and
 * `cops doctor` both run it and only render the result differently.
 */
import { join } from "node:path";
import { isJevCopsEntry } from "./hook-entries.ts";
import { type Spawn, type SpawnResult, spawnProcess } from "./spawn.ts";

/** Longer than the hook's own 13 s PreToolUse deadline, shorter than Claude Code's 30 s. */
export const CANARY_DEFAULT_TIMEOUT_MS = 20_000;

/** The hook as registered: exec form. */
export interface CanaryHook {
  readonly command: string;
  readonly args: readonly string[];
}

/** How to run the canary. */
export interface CanaryOptions {
  readonly hook: CanaryHook;
  /** HOME for the hook process (the user's home). */
  readonly home: string;
  /**
   * The home whose `.claude/settings.json` the write probe targets: copsd's `[daemon] home`,
   * the one `config-tamper` protects (default `home`).
   */
  readonly targetHome?: string;
  /** The payloads' cwd and the hook's working directory (default `home`). */
  readonly cwd?: string;
  /** Base environment; only `PATH` is passed on (plus `HOME`). */
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** Kill the hook after this long (default {@link CANARY_DEFAULT_TIMEOUT_MS}). */
  readonly timeoutMs?: number;
  readonly spawn?: Spawn;
  /** Suffix for the throw-away session ids (default a random UUID). */
  readonly nonce?: string;
  /** Also run the ConfigChange probe on this settings file (see the module doc). */
  readonly config?: CanaryConfigProbe;
}

/** The settings change the ConfigChange probe reports: which file, from which source. */
export interface CanaryConfigProbe {
  /** The settings file named as changed (`file_path`); it is read, never written. */
  readonly filePath: string;
  /** Its ConfigChange `source` (default `user_settings`). */
  readonly source?: string;
  /**
   * The session's project (the payload's `cwd`, the hook's working directory and
   * `CLAUDE_PROJECT_DIR`), whose project and local settings the check reads; default the
   * canary's `cwd`.
   */
  readonly projectDir?: string;
}

/** One probe's verdict: as expected, observe mode, daemon unreachable, or wrong. */
export type CanaryOutcome = "ok" | "observe" | "unreachable" | "failed";

/**
 * One synthetic call and what the hook did with it. `expected` and `observed` share one
 * vocabulary ({@link describeHookRun}); `stderr` is the hook's stderr, or why it did not run
 * ("timed out", the spawn error).
 */
export interface CanaryProbe {
  readonly name: "benign-bash" | "config-write" | "config-change";
  readonly expected: string;
  readonly observed: string;
  readonly outcome: CanaryOutcome;
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * The canary's result. `ok`: the gate works; `observe`: the daemon only reports (nothing is
 * blocked by design); `unreachable`: no daemon answered, so the hook fails closed on every
 * non-read call; `failed`: the hook answered wrongly (e.g. a binary that lets everything
 * through), so the gate is not in force. `detail` is one line for humans.
 */
export interface CanaryResult {
  readonly status: CanaryOutcome;
  readonly detail: string;
  readonly probes: readonly CanaryProbe[];
}

const UNREACHABLE =
  "daemon not reachable: the hook will block every non-read call until copsd runs (fail closed)";
const EXPECTED_BENIGN = "exit 0, no output";
const EXPECTED_WRITE = "exit 2, deny, continue:false (observe mode: exit 0, additionalContext)";
const EXPECTED_CHANGE = "exit 0, no output (the hook finds itself intact)";
const EXPECTED: Readonly<Record<CanaryProbe["name"], string>> = {
  "benign-bash": EXPECTED_BENIGN,
  "config-write": EXPECTED_WRITE,
  "config-change": EXPECTED_CHANGE,
};

/**
 * The two payloads (JSON text), each under its own throw-away session; the write targets
 * `<home>/.claude/settings.json`.
 */
export function canaryPayloads(home: string, cwd: string, nonce: string) {
  const base = (name: string) => ({
    session_id: `jev-cops-canary-${name}-${nonce}`,
    cwd,
    permission_mode: "default",
    hook_event_name: "PreToolUse",
    tool_use_id: `toolu_jevcopscanary_${name}_${nonce.replaceAll("-", "")}`,
  });
  const benign = { ...base("bash"), tool_name: "Bash", tool_input: { command: "true" } };
  const file_path = join(home, ".claude", "settings.json");
  const write = { ...base("write"), tool_name: "Write", tool_input: { file_path, content: "{}" } };
  return { benign: JSON.stringify(benign), write: JSON.stringify(write) };
}

/** The ConfigChange payload: `config.filePath` changed (`config.source`), its own session. */
export function configChangePayload(cwd: string, nonce: string, config: CanaryConfigProbe) {
  return JSON.stringify({
    session_id: `jev-cops-canary-config-${nonce}`,
    cwd,
    permission_mode: "default",
    hook_event_name: "ConfigChange",
    source: config.source ?? "user_settings",
    file_path: config.filePath,
  });
}

function jsonOf(stdout: string): Record<string, unknown> | null {
  try {
    const v: unknown = JSON.parse(stdout.trim());
    return typeof v === "object" && v !== null && !Array.isArray(v)
      ? (v as Record<string, unknown>)
      : null;
  } catch {
    return null; // not JSON: the probe's outcome says what was expected instead
  }
}

function jsonParts(json: Record<string, unknown>): string[] {
  const hso = (json.hookSpecificOutput ?? {}) as Record<string, unknown>;
  const parts = [
    ...(typeof hso.permissionDecision === "string" ? [hso.permissionDecision] : []),
    ...(hso.additionalContext === undefined ? [] : ["additionalContext"]),
    ...(hso.updatedInput === undefined ? [] : ["updatedInput"]),
    ...(json.continue === false ? ["continue:false"] : []),
    ...(json.decision === "block" ? ["block"] : []),
  ];
  return parts.length === 0 ? ["other JSON"] : parts;
}

/**
 * What a hook run did, as Claude Code reads it: `did not start`, `timed out`, or the exit
 * code followed by the JSON decision parts (`exit 2, deny, continue:false`,
 * `exit 0, no output`, `exit 0, non-JSON output`, …).
 */
export function describeHookRun(r: SpawnResult): string {
  if (r.error !== null) return "did not start";
  if (r.timedOut) return "timed out";
  const out = r.stdout.trim();
  const json = out === "" ? null : jsonOf(out);
  const rest = out === "" ? ["no output"] : json === null ? ["non-JSON output"] : jsonParts(json);
  return [`exit ${r.exitCode}`, ...rest].join(", ");
}

function unreachable(r: SpawnResult): boolean {
  return r.exitCode === 2 && /judge (unreachable|timeout)/.test(r.stderr);
}

function benignOutcome(r: SpawnResult): CanaryOutcome {
  if (unreachable(r)) return "unreachable";
  return r.exitCode === 0 && r.stdout.trim() === "" ? "ok" : "failed";
}

function writeOutcome(r: SpawnResult): CanaryOutcome {
  if (unreachable(r)) return "unreachable";
  const json = jsonOf(r.stdout);
  const specific = json?.hookSpecificOutput as Record<string, unknown> | undefined;
  if (r.exitCode === 2 && json?.continue === false && specific?.permissionDecision === "deny") {
    return "ok";
  }
  const note = specific?.additionalContext;
  const observed = typeof note === "string" && note.includes("would have: kill");
  return r.exitCode === 0 && observed ? "observe" : "failed";
}

/** Intact: exit 0 and nothing written (a block is exit 2 + `decision: "block"` + the why). */
function changeOutcome(r: SpawnResult): CanaryOutcome {
  if (unreachable(r)) return "unreachable";
  return r.exitCode === 0 && r.stdout.trim() === "" ? "ok" : "failed";
}

const OUTCOME: Readonly<Record<CanaryProbe["name"], (r: SpawnResult) => CanaryOutcome>> = {
  "benign-bash": benignOutcome,
  "config-write": writeOutcome,
  "config-change": changeOutcome,
};

/**
 * The hook's environment: `PATH` and `HOME` (D-095); the ConfigChange probe also gets what
 * Claude Code gives every hook and the intact check reads to find the settings files:
 * `CLAUDE_PROJECT_DIR` (the cwd) and `CLAUDE_CONFIG_DIR` when set.
 */
function envFor(o: CanaryOptions, name: CanaryProbe["name"]): Record<string, string> {
  const base = { PATH: o.env?.PATH ?? "/usr/bin:/bin", HOME: o.home };
  if (name !== "config-change") return base;
  const configDir = o.env?.CLAUDE_CONFIG_DIR;
  return {
    ...base,
    CLAUDE_PROJECT_DIR: probeCwd(o, name),
    ...(configDir ? { CLAUDE_CONFIG_DIR: configDir } : {}),
  };
}

/** Where a probe runs: the canary's `cwd`, or the ConfigChange probe's project. */
function probeCwd(o: CanaryOptions, name: CanaryProbe["name"]): string {
  const cwd = o.cwd ?? o.home;
  return name === "config-change" ? (o.config?.projectDir ?? cwd) : cwd;
}

async function probe(
  o: CanaryOptions,
  name: CanaryProbe["name"],
  stdin: string,
): Promise<CanaryProbe> {
  const spawn = o.spawn ?? spawnProcess;
  const argv = [o.hook.command, ...o.hook.args];
  const timeoutMs = o.timeoutMs ?? CANARY_DEFAULT_TIMEOUT_MS;
  const r = await spawn({ argv, env: envFor(o, name), cwd: probeCwd(o, name), stdin, timeoutMs });
  return {
    name,
    expected: EXPECTED[name],
    observed: describeHookRun(r),
    outcome: OUTCOME[name](r),
    exitCode: r.exitCode,
    stdout: r.stdout,
    stderr: r.error ?? (r.timedOut ? "timed out" : r.stderr),
  };
}

/** Why the hook blocked the unchanged settings: its own reason, from its JSON or stderr. */
function blockReason(p: CanaryProbe): string {
  const reason = jsonOf(p.stdout)?.reason;
  const text = typeof reason === "string" ? reason : p.stderr;
  return (
    text
      .trim()
      .split("\n")[0]
      ?.replace(/^jev-cops: /, "") ?? ""
  );
}

function summarize(probes: readonly CanaryProbe[]): CanaryResult {
  const bad = probes.find((p) => p.outcome === "failed");
  if (bad?.name === "config-change") {
    const detail = `the hook's own ConfigChange check does not find the registered hook intact (${blockReason(bad)}): Claude Code would block every settings change and jev-cops would end the session; the entry must start the hook exactly as it runs (hook-identity: the same program, started directly or by the same Bun)`;
    return { status: "failed", detail, probes };
  }
  if (bad !== undefined) {
    const got = `${bad.observed}, stdout ${JSON.stringify(bad.stdout.trim().slice(0, 200))}, stderr ${JSON.stringify(bad.stderr.trim().slice(0, 200))}`;
    const detail = `the hook did not answer the ${bad.name} probe as expected (${bad.expected}; got ${got}): the gate is not in force`;
    return { status: "failed", detail, probes };
  }
  if (probes.some((p) => p.outcome === "unreachable")) {
    return { status: "unreachable", detail: UNREACHABLE, probes };
  }
  if (probes.some((p) => p.outcome === "observe")) {
    const detail =
      "copsd is in observe mode: the settings write was only reported ('would have: kill'); nothing is blocked until copsd runs with --enforce";
    return { status: "observe", detail, probes };
  }
  const detail = "the hook let `true` run and blocked a settings write (exit 2, continue:false)";
  return { status: "ok", detail, probes };
}

/**
 * Runs the probes (the benign one first, each in its own session; the ConfigChange one
 * last, when `config` is given) and classifies them.
 */
export async function runOfflineCanary(o: CanaryOptions): Promise<CanaryResult> {
  const nonce = o.nonce ?? crypto.randomUUID();
  const cwd = o.cwd ?? o.home;
  const p = canaryPayloads(o.targetHome ?? o.home, cwd, nonce);
  const benign = await probe(o, "benign-bash", p.benign);
  const write = await probe(o, "config-write", p.write);
  if (o.config === undefined) return summarize([benign, write]);
  const project = o.config.projectDir ?? cwd;
  const change = await probe(o, "config-change", configChangePayload(project, nonce, o.config));
  return summarize([benign, write, change]);
}

/** The jev-cops `PreToolUse` command handler in `settings`, as registered, or null. */
export function registeredPreToolUse(
  settings: Readonly<Record<string, unknown>>,
  hookBinary?: string,
): CanaryHook | null {
  const hooks = settings.hooks as Record<string, unknown> | undefined;
  const groups = hooks?.PreToolUse;
  if (!Array.isArray(groups)) return null;
  for (const g of groups) {
    const handlers = (g as { hooks?: unknown } | null)?.hooks;
    if (!Array.isArray(handlers)) continue;
    const h = handlers.find((x) => isJevCopsEntry(x, hookBinary) && Array.isArray(x.args));
    if (h !== undefined) return { command: h.command as string, args: h.args as string[] };
  }
  return null;
}
