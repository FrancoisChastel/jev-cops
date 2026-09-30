/**
 * Sandbox lifecycle through {@link OpenShellCli}: create with the compiled policy and a
 * pinned advisor posture (D-109, D-119), get, stop (D-112), logs, settings. Argv from the
 * v0.1.2 clap definitions (main.rs:1420-1690, :533-560, :2233-2290); JSON shapes from
 * run.rs (`sandbox_to_json` :2715-2800, `settings_to_json_sandbox` :4925-4964).
 */
import { err, ok, type Result } from "@jev-cops/core";
import {
  ADVISOR_SETTINGS,
  type CreateOptions,
  sandboxCreateArgs,
  settingsSetArgs,
} from "./argv.ts";
import { jsonOf, type OpenShellCli } from "./cli.ts";

/** What `sandbox get -o json` says about a sandbox. */
export interface SandboxInfo {
  readonly name: string;
  /** `Provisioning`, `Ready`, `Error`, `Stopped`, … (commands/common.rs:58-71). */
  readonly phase: string;
  readonly policyVersion: number;
}

/** One setting as `settings get --json` reports it. */
export interface SettingValue {
  readonly value: string;
  /** `global`, `sandbox` or `unset`. */
  readonly scope: string;
}

/** `sandbox create` can take minutes (image pull, provisioning); it returns once ready. */
const CREATE_DEADLINE_MS = 600_000;

function infoOf(value: unknown): Result<SandboxInfo, string> {
  const v = value as { name?: unknown; phase?: unknown; current_policy_version?: unknown } | null;
  if (typeof v?.name !== "string" || typeof v.phase !== "string") {
    return err("sandbox: the JSON has no name or phase");
  }
  const version = typeof v.current_policy_version === "number" ? v.current_policy_version : -1;
  return ok({ name: v.name, phase: v.phase, policyVersion: version });
}

/** `sandbox get <name> --output json` (main.rs:1594-1606). */
export async function sandboxGet(
  cli: OpenShellCli,
  name: string,
): Promise<Result<SandboxInfo, string>> {
  const json = jsonOf(await cli.run(["sandbox", "get", name, "--output", "json"]), "sandbox get");
  return json.ok ? infoOf(json.value) : json;
}

/** `sandbox stop <name>`: waits for `Stopped` (main.rs:1652-1658; sandboxes/overview.mdx). */
export async function sandboxStop(cli: OpenShellCli, name: string): Promise<Result<true, string>> {
  const r = await cli.run(["sandbox", "stop", name]);
  return r.code === 0 ? ok(true) : err(`sandbox stop: exit ${r.code}: ${r.stderr.trim()}`);
}

/** Options of `openshell logs` (main.rs:533-560); no JSON output is documented. */
export interface LogOptions {
  readonly source?: "sandbox" | "gateway" | "all";
  readonly since?: string;
  readonly lines?: number;
}

/** `logs <name> -n <lines> [--source s] [--since d]`; never `--level warn` (it hides policy events). */
export async function sandboxLogs(
  cli: OpenShellCli,
  name: string,
  o: LogOptions,
): Promise<Result<string, string>> {
  const args = [
    "logs",
    name,
    "-n",
    String(o.lines ?? 200),
    ...(o.source === undefined ? [] : ["--source", o.source]),
    ...(o.since === undefined ? [] : ["--since", o.since]),
  ];
  const r = await cli.run(args);
  return r.code === 0 ? ok(r.stdout) : err(`logs: exit ${r.code}: ${r.stderr.trim()}`);
}

/** `settings get <name> --json` (main.rs:2236-2250: `--json`, not `--output`). */
export async function settingsGet(
  cli: OpenShellCli,
  name: string,
): Promise<Result<Record<string, SettingValue>, string>> {
  const json = jsonOf(await cli.run(["settings", "get", name, "--json"]), "settings get");
  if (!json.ok) return json;
  const settings = (json.value as { settings?: unknown } | null)?.settings;
  if (settings === null || typeof settings !== "object") return err("settings get: no settings");
  return ok(settings as Record<string, SettingValue>);
}

/** What in `settings` would let the sandbox widen its own egress (D-119). */
export function advisorProblems(settings: Readonly<Record<string, SettingValue>>): string[] {
  const proposals = settings.agent_policy_proposals_enabled;
  const mode = settings.proposal_approval_mode;
  return [
    ...(proposals?.value === "true"
      ? [`agent_policy_proposals_enabled is true (${proposals.scope}): the agent can propose rules`]
      : []),
    ...(mode?.value === "auto"
      ? [
          `proposal_approval_mode is auto (${mode.scope}): agent-proposed hosts would bypass the judge (D-119)`,
        ]
      : []),
  ];
}

/**
 * Creates the sandbox with the compiled policy, then pins the advisor posture (D-119). If
 * the settings cannot be pinned, the sandbox is stopped: a sandbox whose agent could
 * self-approve egress is not handed over (fail closed).
 */
export async function sandboxCreate(
  cli: OpenShellCli,
  o: CreateOptions,
): Promise<Result<SandboxInfo, string>> {
  const created = jsonOf(await cli.run(sandboxCreateArgs(o), CREATE_DEADLINE_MS), "sandbox create");
  if (!created.ok) return created;
  const info = infoOf(created.value);
  if (!info.ok) return info;
  for (const [key, value] of ADVISOR_SETTINGS) {
    const r = await cli.run(settingsSetArgs(o.name, key, value));
    if (r.code !== 0) {
      const stopped = await sandboxStop(cli, o.name);
      const state = stopped.ok ? "stopped" : `NOT stopped (${stopped.error})`;
      return err(
        `settings set ${key}=${value} failed (${r.stderr.trim()}); sandbox ${o.name} ${state}`,
      );
    }
  }
  return info;
}
