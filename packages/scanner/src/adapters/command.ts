/**
 * Any scanner behind a small contract (README "The command contract"): jev-cops runs
 * `argv + [path]` in the scanned directory with a scrubbed environment and reads one
 * `jev-cops.scan/1` JSON document from stdout. The exit code is ignored (only a spawn
 * failure, the deadline or the output cap make it an error), so a wrapper can reuse its
 * tool's own gate codes. The command never receives the daemon's API keys.
 */
import { accessSync, constants, statSync } from "node:fs";
import { basename } from "node:path";
import { err, ok, type Result } from "@jev-cops/core";
import { MAX_ID_CHARS, oneLine, parseContractOutput } from "../parse.ts";
import { absolutePath, type RunOutcome, runBounded, scanEnv } from "../run.ts";
import type { Env, Scanner, ScannerConfig, ScanResult } from "../types.ts";
import {
  answerResult,
  bunWhich,
  errorResult,
  localTarget,
  outcomeError,
  processEnv,
  type ResultBase,
  type ScannerDeps,
  widestNetwork,
} from "./shared.ts";

/** The `command` variant of {@link ScannerConfig}. */
export type CommandConfig = Extract<ScannerConfig, { adapter: "command" }>;

/** argv[0] as an absolute path: kept when absolute, looked up when a bare name. */
function program(argv0: string | undefined, env: Env, deps: ScannerDeps): Result<string, string> {
  if (argv0 === undefined || argv0.trim() === "") return err("the scanner command is empty");
  if (argv0.startsWith("/")) return ok(argv0);
  if (argv0.includes("/")) {
    return err(`the scanner command must be an absolute path or a bare name: ${argv0}`);
  }
  const found = (deps.which ?? bunWhich)(argv0, absolutePath(env.PATH ?? ""));
  return found === null ? err(`${argv0} not found on PATH`) : ok(found);
}

function executableProblem(path: string): string | null {
  try {
    if (!statSync(path).isFile()) return `${path} is not a file`;
    accessSync(path, constants.X_OK);
    return null;
  } catch {
    return `${path} is missing or not executable`;
  }
}

function interpret(o: RunOutcome, c: CommandConfig, base: ResultBase, started: number): ScanResult {
  if (o.kind === "spawn-error") return errorResult(base, outcomeError(base.tool, o), started);
  const ran: ResultBase = { ...base, network: c.network ?? "provider" };
  if (o.kind !== "exit") return errorResult(ran, outcomeError(base.tool, o), started, o.stderrTail);
  const report = parseContractOutput(o.stdout);
  if (!report.ok) return errorResult(ran, report.error, started, o.stderrTail);
  const r = report.value;
  const known: ResultBase = {
    ...ran,
    tool: r.tool ?? base.tool,
    version: r.version,
    network: widestNetwork(ran.network, r.network),
  };
  if (r.verdict === "error") {
    const why = r.error ?? "the scanner reported an error";
    return errorResult(known, why, started, o.stderrTail);
  }
  return answerResult(known, { verdict: r.verdict, score: r.score, findings: r.findings }, started);
}

/**
 * The `command` scanner. Never throws: an empty or relative argv, a missing program, a URL
 * or a missing target answers `error` without running anything. `network` defaults to
 * `provider` (what jev-cops cannot know is assumed to leave), and a tool may widen it.
 */
export function createCommandScanner(c: CommandConfig, deps: ScannerDeps = {}): Scanner {
  const spawn = deps.spawn ?? runBounded;
  const [argv0, ...args] = c.argv;
  const tool = oneLine(basename(argv0 ?? "") || "command", MAX_ID_CHARS);
  const base: ResultBase = { tool, mode: c.mode ?? "static", network: "none", version: null };
  return {
    name: "command",
    async available() {
      const bin = program(argv0, deps.env ?? processEnv(), deps);
      if (!bin.ok) return { ok: false, reason: bin.error };
      const problem = executableProblem(bin.value);
      return problem === null ? { ok: true, version: null } : { ok: false, reason: problem };
    },
    async scan(target, opts) {
      const started = performance.now();
      const t = localTarget(target);
      if (!t.ok) return errorResult(base, t.error, started);
      const source = opts.env ?? deps.env ?? processEnv();
      const bin = program(argv0, source, deps);
      if (!bin.ok) return errorResult(base, bin.error, started);
      const signal = opts.signal === undefined ? {} : { signal: opts.signal };
      const o = await spawn({
        argv: [bin.value, ...args, t.value.path],
        cwd: opts.cwd ?? t.value.dir,
        env: scanEnv(source),
        deadlineMs: opts.deadlineMs,
        ...signal,
      });
      return interpret(o, c, base, started);
    },
  };
}
