/**
 * `cops doctor` end to end (PLAN-M1 §4.4): config, copsd on both sockets, the audit chain,
 * then per harness its checks, the offline canary through the registered hook, the gated
 * live canary, and every known gap. Read-only: it reads files and sockets, and starts only
 * `claude --version`, the registered hook (`--version`, the canary payloads) and, with
 * `--live` and `JEV_COPS_LIVE_CANARY=1`, `claude -p`.
 */
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { CLAUDE_CODE_GAPS, CLAUDE_CODE_STATE_FILE } from "@jev-cops/adapter-claude-code";
import { PI_GAPS } from "@jev-cops/adapter-pi/install";
import { ConfigError, type LoadedConfig, loadConfig } from "@jev-cops/daemon";
import { type CanaryHook, canaryChecks, doctorCanary } from "./doctor-canary.ts";
import {
  claudeVersionChecks,
  hookLogCheck,
  recordedVersionCheck,
  trustCheck,
} from "./doctor-claude.ts";
import { keyChecks } from "./doctor-claude-keys.ts";
import { auditChecks, type DaemonProbe, daemonChecks, probeDaemon } from "./doctor-daemon.ts";
import {
  binaryChecks,
  duplicatesCheck,
  execFormCheck,
  foreignHooksCheck,
  type HookFacts,
  hookFacts,
  hookVersionChecks,
  registrationCheck,
  socketChecks,
} from "./doctor-hook-checks.ts";
import { liveCanaryChecks } from "./doctor-live.ts";
import { gapChecks, piChecks } from "./doctor-pi.ts";
import { identityOf, readClaudeSettings, samePath } from "./doctor-settings.ts";
import { type Check, check, type DoctorEnv, type HarnessChoice } from "./doctor-types.ts";

/** What `cops doctor` was asked for. */
export interface DoctorOptions {
  readonly harness: HarnessChoice;
  readonly live: boolean;
  readonly socket?: string;
  readonly adminSocket?: string;
  readonly config?: string;
}

/** The process around a run: its view of the machine and where notices go. */
export interface DoctorDeps {
  readonly env: DoctorEnv;
  readonly notice: (line: string) => void;
}

/** The daemon paths the doctor uses. */
interface DaemonPaths {
  readonly socket: string;
  readonly adminSocket: string;
  readonly audit: string;
  /** copsd's home: the canary's config write targets `<home>/.claude/settings.json`. */
  readonly home: string;
}

/** The default paths under `home` (what copsd uses without a config file). */
function defaultPaths(home: string): DaemonPaths {
  const dir = join(home, ".jev-cops");
  return {
    socket: join(dir, "copsd.sock"),
    adminSocket: join(dir, "copsd-admin.sock"),
    audit: join(dir, "audit.jsonl"),
    home,
  };
}

function loadedPart(loaded: LoadedConfig): { check: Check; paths: DaemonPaths } {
  const { daemon, audit } = loaded.config;
  const paths = {
    socket: daemon.socket,
    adminSocket: daemon.adminSocket,
    audit: audit.path,
    home: daemon.home,
  };
  const from =
    loaded.sources.length === 0 ? "no cops.toml: defaults" : `loaded ${loaded.sources.join(", ")}`;
  if (loaded.rejected.length === 0)
    return { check: check("config", "cops.toml", "ok", from), paths };
  const dropped = `the repo override may only tighten, dropped: ${loaded.rejected.join("; ")}`;
  return { check: check("config", "cops.toml", "warn", `${from}; ${dropped}`), paths };
}

/** The daemon config as copsd would load it here (same precedence), read-only. */
function configPart(o: DoctorOptions, e: DoctorEnv): { check: Check; paths: DaemonPaths } {
  const configPath = o.config === undefined ? undefined : resolve(e.cwd, o.config);
  const where = configPath === undefined ? {} : { configPath };
  try {
    return loadedPart(loadConfig({ ...where, env: e.env, cwd: e.cwd, home: e.home }));
  } catch (cause) {
    if (!(cause instanceof ConfigError)) throw cause;
    const detail = `${cause.message}; copsd will not start with it (defaults assumed below)`;
    return { check: check("config", "cops.toml", "fail", detail), paths: defaultPaths(e.home) };
  }
}

/** Matchers under which Claude Code sends every tool to a PreToolUse group. */
const MATCH_ALL: ReadonlySet<unknown> = new Set([undefined, "", "*"]);

/**
 * The PreToolUse hooks to run the canary through: exec form and in a group matching every
 * tool, since Claude Code would never send a `Write` to a hook scoped to other tools.
 */
function canaryHooks(f: HookFacts, e: DoctorEnv): { hook: CanaryHook; socket: string | null }[] {
  const seen = new Set<string>();
  return f.cops.flatMap(({ ref, form }) => {
    if (form !== "exec" || ref.event !== "PreToolUse" || !MATCH_ALL.has(ref.group.matcher))
      return [];
    const id = identityOf(ref.handler, f.view.projectDir, e);
    if (seen.has(id.key)) return [];
    seen.add(id.key);
    const timeout = ref.handler.timeout;
    const hook = {
      command: id.commandFile ?? id.command,
      args: id.args,
      ...(typeof timeout === "number" ? { timeoutS: timeout } : {}),
    };
    return [{ hook, socket: id.socket }];
  });
}

/** Why the canary cannot run at all, or null. */
function canaryBlocked(hooks: readonly unknown[], probe: DaemonProbe): Check | null {
  if (hooks.length === 0) {
    const detail = "not run: no jev-cops PreToolUse hook is registered for every tool";
    return check("canary", "offline canary", "warn", detail);
  }
  if (probe.agent.ok) return null;
  const detail = `not run: copsd is not reachable on ${probe.socket}, so the hook would block every call; start copsd and re-run`;
  return check("canary", "offline canary", "fail", detail);
}

/**
 * The offline canary (the adapter's, shared with `cops install`) through each registered
 * PreToolUse hook that talks to copsd's socket (a hook on another socket would only fail
 * closed, and write its local log); never when copsd is unreachable (D-092).
 */
async function canarySection(
  f: HookFacts,
  e: DoctorEnv,
  probe: DaemonProbe,
  daemonHome: string,
): Promise<Check[]> {
  const hooks = canaryHooks(f, e);
  const blocked = canaryBlocked(hooks, probe);
  if (blocked !== null) return [blocked];
  const out: Check[] = [];
  for (const { hook, socket } of hooks) {
    if (socket === null || !samePath(socket, probe.socket)) {
      const detail = `not run through ${hook.command}: it does not talk to copsd's socket (see socket)`;
      out.push(check("canary", "offline canary", "warn", detail));
      continue;
    }
    const opts = { hook, home: e.home, daemonHome, cwd: f.view.projectDir, env: e.env, run: e.run };
    out.push(...canaryChecks(await doctorCanary(opts), hook));
  }
  return out;
}

function claudeDetected(e: DoctorEnv, claudeOnPath: boolean, f: HookFacts): boolean {
  const state = join(e.home, ".jev-cops", CLAUDE_CODE_STATE_FILE);
  return claudeOnPath || f.view.reads.some((r) => r.read.kind !== "missing") || existsSync(state);
}

async function claudeCodeChecks(
  o: DoctorOptions,
  deps: DoctorDeps,
  probe: DaemonProbe,
  paths: DaemonPaths,
): Promise<Check[]> {
  const e = deps.env;
  const version = await claudeVersionChecks(e);
  const facts = hookFacts(readClaudeSettings(e), e);
  if (o.harness === "all" && !claudeDetected(e, e.which("claude") !== null, facts)) {
    return [
      check(
        "claude-code",
        "detected",
        "warn",
        `Claude Code not detected (no claude on PATH, no settings under ${e.env.CLAUDE_CONFIG_DIR || join(e.home, ".claude")} or the project): skipped; \`cops doctor --harness claude-code\` checks it anyway`,
      ),
    ];
  }
  const installed = facts.cops.length > 0;
  return [
    ...version.checks,
    recordedVersionCheck(e.home, version.version),
    registrationCheck(facts, e),
    ...(installed ? [execFormCheck(facts)] : []),
    ...binaryChecks(facts),
    ...(await hookVersionChecks(facts, e)),
    ...socketChecks(facts, probe.socket),
    ...(installed ? [duplicatesCheck(facts)] : []),
    foreignHooksCheck(facts),
    ...keyChecks(facts),
    trustCheck(e, facts.view.projectDir),
    hookLogCheck(e.home),
    ...(await canarySection(facts, e, probe, paths.home)),
    ...(o.live ? await liveCanaryChecks({ e, auditPath: paths.audit, notice: deps.notice }) : []),
  ];
}

/** Runs every check `o` asks for, in report order. */
export async function runDoctor(o: DoctorOptions, deps: DoctorDeps): Promise<Check[]> {
  const e = deps.env;
  const config = configPart(o, e);
  const socket = resolve(e.cwd, o.socket ?? config.paths.socket);
  const adminSocket = resolve(e.cwd, o.adminSocket ?? config.paths.adminSocket);
  const probe = await probeDaemon(socket, adminSocket);
  const claude = o.harness !== "pi";
  const pi = o.harness !== "claude-code";
  return [
    config.check,
    ...daemonChecks(probe),
    ...auditChecks(config.paths.audit),
    ...(claude ? await claudeCodeChecks(o, deps, probe, config.paths) : []),
    ...(pi ? piChecks(e, socket, o.harness === "pi") : []),
    ...(claude ? gapChecks("claude-code gaps", CLAUDE_CODE_GAPS) : []),
    ...(pi ? gapChecks("pi gaps", PI_GAPS) : []),
  ];
}
