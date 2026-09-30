/**
 * `OpenShellCli`: the `openshell` v0.1.2 binary driven the way D-067 drives git. An absolute
 * binary path (found on PATH once and recorded, never resolved per call), argv arrays (no
 * shell), a scrubbed environment built from scratch, a deadline per call with SIGKILL, and
 * `--output json` wherever the command has it. `--wait` exit codes are mapped as documented:
 * "It exits with status `1` if the sandbox rejects the revision, and with status `124` if
 * the wait times out" (manage-policies.mdx:254-258; run.rs:5190-5245). A successful exit
 * "does not always mean your change is active", so callers confirm with {@link
 * OpenShellCli.latestLoaded} (`policy list`, status `loaded`).
 */
import { err, ok, type Result } from "@jev-cops/core";
import {
  policyGetBaseArgs,
  policyListArgs,
  policySetArgs,
  policyUpdateArgs,
  removeRuleArgs,
  WAIT_TIMEOUT_S,
} from "./argv.ts";
import { type OpenShellPolicy, parsePolicy } from "./schema.ts";
import type { PolicyUpdate } from "./types.ts";

/** What one call produced. */
export interface RunResult {
  /** Exit code; -1 when the process could not start or was killed. */
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
  /** Killed at the wrapper's deadline. */
  readonly deadline: boolean;
  /** Why the process could not start, or null. */
  readonly spawnError: string | null;
}

/** Runs `argv` (binary first) with exactly `env`; injected in tests. */
export type Runner = (
  argv: readonly string[],
  env: Readonly<Record<string, string>>,
  deadlineMs: number,
) => Promise<RunResult>;

/** How to run `openshell`. */
export interface OpenShellCliOptions {
  /** Absolute path of the `openshell` binary. */
  readonly binary: string;
  /** HOME for the CLI's own gateway metadata (`~/.config/openshell/…`). */
  readonly home: string;
  /** PATH to pass (relative entries dropped); default the process's. */
  readonly pathEnv?: string;
  /** `OPENSHELL_GATEWAY` (main.rs:437-445); never inherited. */
  readonly gateway?: string | null;
  /** `OPENSHELL_WORKSPACE` (main.rs:466-474); never inherited. */
  readonly workspace?: string | null;
  /** Deadline of a call without `--wait`; default 20 s. */
  readonly deadlineMs?: number;
  /** Deadline of a `--wait` call; default the wait timeout plus 10 s. */
  readonly waitDeadlineMs?: number;
  readonly runner?: Runner;
}

/** How an apply ended: `--wait` exit 0/1/124, another code, our deadline, or no process. */
export type ApplyStatus = "applied" | "rejected" | "timeout" | "failed" | "deadline" | "not-run";

/** The outcome of a policy change. */
export interface ApplyResult {
  readonly status: ApplyStatus;
  readonly code: number;
  readonly stderr: string;
}

/** One `policy list` revision (run.rs:5747-5800). */
export interface PolicyRevision {
  readonly version: number;
  /** `pending`, `loaded`, `failed`, `superseded` or `unspecified` (run.rs:5737-5745). */
  readonly status: string;
  readonly loadError: string | null;
}

/** The wrapper. */
export interface OpenShellCli {
  readonly binary: string;
  /** Runs `openshell <args>` under the wrapper's rules. */
  run(args: readonly string[], deadlineMs?: number): Promise<RunResult>;
  policyUpdate(sandbox: string, update: PolicyUpdate): Promise<ApplyResult>;
  removeRule(sandbox: string, rule: string): Promise<ApplyResult>;
  policySet(sandbox: string, file: string): Promise<ApplyResult>;
  policyGetBase(
    sandbox: string,
  ): Promise<Result<{ version: number; policy: OpenShellPolicy }, string>>;
  policyList(sandbox: string): Promise<Result<PolicyRevision[], string>>;
  latestLoaded(sandbox: string): Promise<Result<boolean, string>>;
  version(): Promise<Result<string, string>>;
}

const DEFAULT_DEADLINE_MS = 20_000;
const WAIT_MARGIN_MS = 10_000;
const NOT_RUN = (why: string): RunResult => ({
  code: -1,
  stdout: "",
  stderr: "",
  deadline: false,
  spawnError: why,
});

/** The real runner: `Bun.spawn` with stdin closed, both streams read, SIGKILL at the deadline. */
export const bunRunner: Runner = async (argv, env, deadlineMs) => {
  let proc: ReturnType<typeof Bun.spawn<"ignore", "pipe", "pipe">>;
  try {
    proc = Bun.spawn([...argv], {
      env: { ...env },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      timeout: deadlineMs,
      killSignal: "SIGKILL",
    });
  } catch (cause) {
    return NOT_RUN((cause as Error).message);
  }
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  const killed = proc.signalCode === "SIGKILL";
  return { code: killed ? -1 : code, stdout, stderr, deadline: killed, spawnError: null };
};

/**
 * The whole environment `openshell` runs with: HOME, PATH without relative entries,
 * `NO_COLOR` and `OPENSHELL_NO_BROWSER` (no ANSI, no browser login), and the configured
 * gateway and workspace. Nothing is inherited, so `OPENSHELL_SANDBOX_POLICY` (a policy file
 * `sandbox create` would use), `OPENSHELL_GATEWAY_INSECURE` (skip TLS checks) and proxy
 * variables never reach it.
 */
export function openShellEnv(o: OpenShellCliOptions): Record<string, string> {
  const path = (o.pathEnv ?? process.env.PATH ?? "")
    .split(":")
    .filter((d) => d.startsWith("/"))
    .join(":");
  return {
    HOME: o.home,
    PATH: path,
    NO_COLOR: "1",
    OPENSHELL_NO_BROWSER: "1",
    ...(o.gateway ? { OPENSHELL_GATEWAY: o.gateway } : {}),
    ...(o.workspace ? { OPENSHELL_WORKSPACE: o.workspace } : {}),
  };
}

/** Maps a `--wait` call's result (manage-policies.mdx:254-258). */
export function applyResult(r: RunResult): ApplyResult {
  const status: ApplyStatus =
    r.spawnError !== null
      ? "not-run"
      : r.deadline
        ? "deadline"
        : r.code === 0
          ? "applied"
          : r.code === 1
            ? "rejected"
            : r.code === 124
              ? "timeout"
              : "failed";
  return { status, code: r.code, stderr: (r.spawnError ?? r.stderr).trim() };
}

/** Parses a command's JSON stdout, or explains why not. */
export function jsonOf(r: RunResult, what: string): Result<unknown, string> {
  if (r.spawnError !== null) return err(`${what}: openshell did not start: ${r.spawnError}`);
  if (r.deadline) return err(`${what}: openshell did not answer in time`);
  if (r.code !== 0) return err(`${what}: exit ${r.code}: ${r.stderr.trim()}`);
  try {
    return ok(JSON.parse(r.stdout) as unknown);
  } catch {
    return err(`${what}: the output is not JSON`);
  }
}

function revisionsOf(value: unknown): Result<PolicyRevision[], string> {
  const list = (value as { revisions?: unknown } | null)?.revisions;
  if (!Array.isArray(list)) return err("policy list: no revisions array");
  return ok(
    list.map((r: { version?: unknown; status?: unknown; load_error?: unknown }) => ({
      version: typeof r.version === "number" ? r.version : -1,
      status: typeof r.status === "string" ? r.status : "unspecified",
      loadError: typeof r.load_error === "string" ? r.load_error : null,
    })),
  );
}

function baseOf(value: unknown): Result<{ version: number; policy: OpenShellPolicy }, string> {
  const v = value as { version?: unknown; policy?: unknown } | null;
  const parsed = parsePolicy(v?.policy);
  if (!parsed.ok)
    return err(`policy get: the base policy fails the schema mirror: ${parsed.error.join("; ")}`);
  return ok({ version: typeof v?.version === "number" ? v.version : -1, policy: parsed.value });
}

/** Builds the wrapper; refuses a binary that is not an absolute path. */
export function openShellCli(o: OpenShellCliOptions): Result<OpenShellCli, string> {
  if (!o.binary.startsWith("/"))
    return err(`openshell binary must be an absolute path: ${o.binary}`);
  const env = openShellEnv(o);
  const runner = o.runner ?? bunRunner;
  const deadline = o.deadlineMs ?? DEFAULT_DEADLINE_MS;
  const waitDeadline = o.waitDeadlineMs ?? WAIT_TIMEOUT_S * 1000 + WAIT_MARGIN_MS;
  const run = (args: readonly string[], ms = deadline) => runner([o.binary, ...args], env, ms);
  const apply = async (args: readonly string[]) => applyResult(await run(args, waitDeadline));
  const cli: OpenShellCli = {
    binary: o.binary,
    run,
    policyUpdate: (sandbox, update) => apply(policyUpdateArgs(sandbox, update)),
    removeRule: (sandbox, rule) => apply(removeRuleArgs(sandbox, rule)),
    policySet: (sandbox, file) => apply(policySetArgs(sandbox, file)),
    policyGetBase: async (sandbox) => {
      const json = jsonOf(await run(policyGetBaseArgs(sandbox)), "policy get");
      return json.ok ? baseOf(json.value) : json;
    },
    policyList: async (sandbox) => {
      const json = jsonOf(await run(policyListArgs(sandbox)), "policy list");
      return json.ok ? revisionsOf(json.value) : json;
    },
    latestLoaded: async (sandbox) => {
      const revisions = await cli.policyList(sandbox);
      if (!revisions.ok) return revisions;
      const latest = revisions.value.toSorted((a, b) => b.version - a.version)[0];
      return ok(latest?.status === "loaded");
    },
    version: async () => {
      const r = await run(["--version"]);
      return r.code === 0 ? ok(r.stdout.trim()) : err(`openshell --version: exit ${r.code}`);
    },
  };
  return ok(cli);
}
