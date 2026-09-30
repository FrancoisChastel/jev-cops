/**
 * NVIDIA SkillSpector through its CLI, the documented stable contract (README "Integrating
 * SkillSpector"): `skillspector scan <path> --format json`, `--no-llm` unless `mode = "llm"`.
 * Exit 0 or 1 with the JSON report is a verdict (the `recommendation` field, never the score
 * or the exit code); exit 2, any other exit, no JSON or a schema miss is `error`. The MCP
 * mode is never used (default LLM on, a known stdio hang, no exit codes).
 */
import { basename } from "node:path";
import { err, ok, type Result } from "@jev-cops/core";
import { parseSkillspectorReport } from "../parse.ts";
import { absolutePath, type RunOutcome, runBounded, scanEnv } from "../run.ts";
import type { Availability, Env, ScanMode, Scanner, ScannerConfig, ScanResult } from "../types.ts";
import {
  answerResult,
  bunWhich,
  errorResult,
  exitError,
  type LocalTarget,
  localTarget,
  outcomeError,
  processEnv,
  type ResultBase,
  type ScannerDeps,
  versionOf,
} from "./shared.ts";

/** The `skillspector` variant of {@link ScannerConfig}. */
export type SkillspectorConfig = Extract<ScannerConfig, { adapter: "skillspector" }>;

const TOOL = "skillspector";
const VERSION_TIMEOUT_MS = 2_000;
const DOCKER_VERSION_TIMEOUT_MS = 10_000;

/**
 * The provider variables SkillSpector documents (README "Environment Variables", plus the
 * standard AWS credential chain Bedrock resolves). Passed in `llm` mode only; a static scan
 * never sees a key.
 */
export const SKILLSPECTOR_LLM_ENV: readonly string[] = Object.freeze([
  "SKILLSPECTOR_PROVIDER",
  "SKILLSPECTOR_MODEL",
  "SKILLSPECTOR_MODEL_REGISTRY",
  "SKILLSPECTOR_REASONING_EFFORT",
  "SKILLSPECTOR_OUTPUT_LANGUAGE",
  "SKILLSPECTOR_TEMPERATURE",
  "SKILLSPECTOR_SEED",
  "SKILLSPECTOR_COMPACT_PROMPTS",
  "SKILLSPECTOR_STRUCTURED_OUTPUT_METHOD",
  "SKILLSPECTOR_COMPAT_API_KEY",
  "SKILLSPECTOR_COMPAT_BASE_URL",
  "NVIDIA_INFERENCE_KEY",
  "OPENAI_API_KEY",
  "OPENAI_BASE_URL",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_PROXY_ENDPOINT_URL",
  "ANTHROPIC_PROXY_API_KEY",
  "ANTHROPIC_PROXY_API_VERSION",
  "AWS_PROFILE",
  "AWS_REGION",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
  "OLLAMA_BASE_URL",
  "AZURE_OPENAI_API_KEY",
  "AZURE_OPENAI_ENDPOINT",
  "AZURE_OPENAI_DEPLOYMENT",
  "AZURE_OPENAI_API_VERSION",
]);

/** What the docker CLI itself needs to reach the engine. */
const DOCKER_ENV = ["DOCKER_HOST", "DOCKER_CONTEXT", "DOCKER_CONFIG", "DOCKER_CERT_PATH"];

/**
 * The only flags `extraArgs` may carry: strict gates, the scan's reach and a team's own
 * rules or baseline (absolute path). Never `--use-shipped-baseline` (a skill author's
 * baseline could suppress findings), `--format`/`--output` or `--no-llm`, which we own.
 */
const EXTRA_FLAGS: Readonly<Record<string, "flag" | "path">> = {
  "--fail-on-findings": "flag",
  "--fail-on-incomplete": "flag",
  "--recursive": "flag",
  "--transitive": "flag",
  "--yara-rules-dir": "path",
  "--baseline": "path",
  "-b": "path",
};

/** Why `args` cannot be passed to SkillSpector, or null. Path flags do not reach a container. */
export function extraArgsProblem(args: readonly string[], docker: boolean): string | null {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] ?? "";
    const [flag = "", inline] = arg.startsWith("--") ? arg.split(/=(.*)/s) : [arg];
    const kind = Object.hasOwn(EXTRA_FLAGS, flag) ? EXTRA_FLAGS[flag] : undefined;
    if (kind === undefined) return `extra argument not allowed: ${flag}`;
    if (kind === "flag") continue;
    if (docker) return `${flag} is not supported with docker`;
    const value = inline ?? args[++i];
    if (value === undefined || !value.startsWith("/")) return `${flag} needs an absolute path`;
  }
  return null;
}

function configProblem(c: SkillspectorConfig): string | null {
  if (c.docker != null && c.docker.image.trim() === "") return "the docker image must be named";
  return extraArgsProblem(c.extraArgs ?? [], c.docker != null);
}

/** The absolute program to run: docker, the configured binary, or `skillspector` on PATH. */
function program(
  c: SkillspectorConfig,
  env: Env,
  which: ScannerDeps["which"],
): Result<string, string> {
  const find = which ?? bunWhich;
  const path = absolutePath(env.PATH ?? "");
  if (c.docker != null) return orErr(find("docker", path), "docker not found on PATH");
  if (c.binary === undefined) return orErr(find(TOOL, path), `${TOOL} not found on PATH`);
  if (!c.binary.startsWith("/")) {
    return err(`${TOOL} binary must be an absolute path: ${c.binary}`);
  }
  return ok(c.binary);
}

const orErr = (value: string | null, message: string): Result<string, string> =>
  value === null ? err(message) : ok(value);

interface Invocation {
  readonly argv: string[];
  readonly env: Record<string, string>;
}

function scanFlags(mode: ScanMode, extra: readonly string[]): string[] {
  return ["--format", "json", ...(mode === "llm" ? [] : ["--no-llm"]), ...extra];
}

function invocation(
  c: SkillspectorConfig,
  bin: string,
  t: LocalTarget,
  deadlineMs: number,
  source: Env,
): Invocation {
  const mode = c.mode ?? "static";
  const bounds = {
    SKILLSPECTOR_MAX_WORKFLOW_SECONDS: String(Math.max(1, Math.ceil(deadlineMs / 1000))),
    SKILLSPECTOR_LOG_LEVEL: "ERROR",
  };
  const llm = mode === "llm" ? SKILLSPECTOR_LLM_ENV : [];
  const flags = scanFlags(mode, c.extraArgs ?? []);
  if (c.docker == null) {
    return { argv: [bin, "scan", t.path, ...flags], env: scanEnv(source, llm, bounds) };
  }
  const env = scanEnv(source, [...DOCKER_ENV, ...llm], bounds);
  const names = [...Object.keys(bounds), ...llm.filter((n) => env[n] !== undefined)];
  const inner = t.kind === "dir" ? "/scan" : `/scan/${basename(t.path)}`;
  const argv = [
    bin,
    "run",
    "--rm",
    ...(c.docker.network === "none" ? ["--network", "none"] : []),
    ...["--cap-drop", "ALL", "--security-opt", "no-new-privileges"],
    ...["-v", `${t.dir}:/scan:ro`],
    ...names.flatMap((n) => ["-e", n]),
    c.docker.image,
    "scan",
    inner,
    ...flags,
  ];
  return { argv, env };
}

function interpret(o: RunOutcome, base: ResultBase, root: string, started: number): ScanResult {
  if (o.kind === "spawn-error") return errorResult(base, outcomeError(TOOL, o), started);
  const ran: ResultBase = { ...base, network: base.mode === "llm" ? "provider" : "osv-only" };
  if (o.kind !== "exit") return errorResult(ran, outcomeError(TOOL, o), started, o.stderrTail);
  if (o.code !== 0 && o.code !== 1) {
    return errorResult(ran, exitError(TOOL, o.code, o.stderrTail), started, o.stderrTail);
  }
  const report = parseSkillspectorReport(o.stdout, root);
  if (!report.ok) return errorResult(ran, report.error, started, o.stderrTail);
  const r = report.value;
  const known: ResultBase = { ...ran, version: r.version };
  if (r.llmRequested && !r.llmAvailable) {
    const why = r.llmError === null ? "" : `: ${r.llmError}`;
    return errorResult(known, `LLM analysis was requested but did not run${why}`, started);
  }
  if (r.llmRequested && base.mode === "static") {
    const msg = "SkillSpector ran an LLM pass although static mode was configured";
    return errorResult({ ...known, network: "provider" }, msg, started);
  }
  return answerResult({ ...known, network: r.llmRequested ? "provider" : "osv-only" }, r, started);
}

async function checkVersion(
  c: SkillspectorConfig,
  bin: string,
  source: Env,
  spawn: NonNullable<ScannerDeps["spawn"]>,
): Promise<Availability> {
  const docker = c.docker != null;
  const argv = docker
    ? [bin, "run", "--rm", "--network", "none", c.docker.image, "--version"]
    : [bin, "--version"];
  const env = scanEnv(source, docker ? DOCKER_ENV : []);
  const deadlineMs = docker ? DOCKER_VERSION_TIMEOUT_MS : VERSION_TIMEOUT_MS;
  const o = await spawn({ argv, cwd: "/", env, deadlineMs });
  if (o.kind !== "exit") return { ok: false, reason: outcomeError(TOOL, o) };
  if (o.code !== 0)
    return { ok: false, reason: exitError(`${TOOL} --version`, o.code, o.stderrTail) };
  return { ok: true, version: versionOf(o.stdout) };
}

/**
 * The SkillSpector scanner. Never throws: a bad config, a missing binary or docker, a URL or
 * a missing target answers `error` without running anything.
 */
export function createSkillspectorScanner(c: SkillspectorConfig, deps: ScannerDeps = {}): Scanner {
  const spawn = deps.spawn ?? runBounded;
  const problem = configProblem(c);
  const mode = c.mode ?? "static";
  const base: ResultBase = { tool: TOOL, mode, network: "none", version: null };
  return {
    name: "skillspector",
    async available() {
      if (problem !== null) return { ok: false, reason: problem };
      const source = deps.env ?? processEnv();
      const bin = program(c, source, deps.which);
      if (!bin.ok) return { ok: false, reason: bin.error };
      return checkVersion(c, bin.value, source, spawn);
    },
    async scan(target, opts) {
      const started = performance.now();
      if (problem !== null) return errorResult(base, problem, started);
      const t = localTarget(target);
      if (!t.ok) return errorResult(base, t.error, started);
      const source = opts.env ?? deps.env ?? processEnv();
      const bin = program(c, source, deps.which);
      if (!bin.ok) return errorResult(base, bin.error, started);
      if (c.docker != null && t.value.dir.includes(":")) {
        return errorResult(base, "cannot mount a path containing ':' into the container", started);
      }
      const { argv, env } = invocation(c, bin.value, t.value, opts.deadlineMs, source);
      const cwd = opts.cwd ?? t.value.dir;
      const signal = opts.signal === undefined ? {} : { signal: opts.signal };
      const o = await spawn({ argv, cwd, env, deadlineMs: opts.deadlineMs, ...signal });
      return interpret(o, base, c.docker == null ? t.value.dir : "/scan", started);
    },
  };
}
