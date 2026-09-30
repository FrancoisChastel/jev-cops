/**
 * What every adapter shares: where the tool is found, which targets may be scanned, and how
 * a run's outcome becomes a {@link ScanResult}. Nothing here throws.
 */
import { statSync } from "node:fs";
import { dirname, isAbsolute } from "node:path";
import { err, ok, type Result } from "@jev-cops/core";
import { keepFindings, MAX_ID_CHARS, oneLine, promptLikeOf } from "../parse.ts";
import { absolutePath, type RunOutcome, type Spawn } from "../run.ts";
import type {
  Env,
  ScanFinding,
  ScanMode,
  ScanNetwork,
  ScanResult,
  ScanTarget,
  ScanVerdict,
} from "../types.ts";

/** Finds a program on a `PATH` (absolute entries only); null when absent. Injected in tests. */
export type Which = (name: string, pathEnv: string) => string | null;

/** `Bun.which` over the absolute entries of `pathEnv`. */
export const bunWhich: Which = (name, pathEnv) => Bun.which(name, { PATH: absolutePath(pathEnv) });

/** What an adapter reads from its surroundings; every field defaults to the real one. */
export interface ScannerDeps {
  /** Runs the tool. Default: the bounded runner (`runBounded`). */
  readonly spawn?: Spawn;
  /** The daemon's environment (default `process.env`); never the agent's. */
  readonly env?: Env;
  readonly which?: Which;
}

/** The answer to a URL target: the scanner never fetches (PLAN-SETUP §4.3, S-8). */
export const REMOTE_NOT_FETCHED = "remote source not fetched";

/** A local target, checked: absolute, present, of the kind it claims. */
export interface LocalTarget {
  readonly kind: "dir" | "file";
  readonly path: string;
  /** The directory itself, or a file's parent: the scan's cwd and what paths are relative to. */
  readonly dir: string;
}

/** The target as a checked local path, or why it cannot be scanned. */
export function localTarget(target: ScanTarget): Result<LocalTarget, string> {
  if (target.kind === "url") return err(REMOTE_NOT_FETCHED);
  const { kind, path } = target;
  if (!isAbsolute(path) || path.includes("\0")) {
    return err(`scan target must be an absolute path: ${oneLine(path)}`);
  }
  let isDir: boolean;
  try {
    isDir = statSync(path).isDirectory();
  } catch {
    return err(`scan target not found: ${oneLine(path)}`);
  }
  if (isDir !== (kind === "dir")) return err(`scan target is not a ${kind}: ${oneLine(path)}`);
  return ok({ kind, path, dir: kind === "dir" ? path : dirname(path) });
}

/** The fields of a result that do not depend on the answer. */
export interface ResultBase {
  readonly tool: string;
  readonly mode: ScanMode;
  readonly network: ScanNetwork;
  readonly version: string | null;
}

const elapsed = (started: number) => Math.max(0, Math.round(performance.now() - started));

/** A `verdict: "error"` result; `error` is flattened to one line, stderr kept when non-empty. */
export function errorResult(
  base: ResultBase,
  error: string,
  started: number,
  stderrTail: string | null = null,
): ScanResult {
  const line = oneLine(error) || "scanner error";
  return {
    ...base,
    verdict: "error",
    score: null,
    findings: [],
    truncated: 0,
    durationMs: elapsed(started),
    error: line,
    promptLike: promptLikeOf([line]),
    stderrTail: stderrTail === null || stderrTail === "" ? null : stderrTail,
  };
}

/** A result carrying the tool's verdict, its findings kept most severe first (64 + count). */
export function answerResult(
  base: ResultBase,
  answer: {
    readonly verdict: Exclude<ScanVerdict, "error">;
    readonly score: number | null;
    readonly findings: readonly ScanFinding[];
  },
  started: number,
): ScanResult {
  const kept = keepFindings(answer.findings);
  return {
    ...base,
    verdict: answer.verdict,
    score: answer.score,
    findings: kept.findings,
    truncated: kept.truncated,
    durationMs: elapsed(started),
    error: null,
    promptLike: promptLikeOf(kept.findings.map((f) => f.title)),
    stderrTail: null,
  };
}

/** The error line for a run that did not exit on its own. */
export function outcomeError(tool: string, outcome: Exclude<RunOutcome, { kind: "exit" }>): string {
  switch (outcome.kind) {
    case "spawn-error":
      return `could not start ${tool}: ${outcome.error}`;
    case "timeout":
      return "timeout";
    case "overflow":
      return "scanner output over 4 MiB";
    case "aborted":
      return "aborted";
  }
}

/** The last non-empty line of `text`, flattened; empty when there is none. */
export function lastLine(text: string): string {
  const lines = text.split(/\r?\n/).filter((l) => l.trim() !== "");
  return oneLine(lines.at(-1) ?? "");
}

/** `name exited N`, with the last stderr line when there is one. */
export function exitError(name: string, code: number, stderrTail: string): string {
  const line = lastLine(stderrTail);
  return line === "" ? `${name} exited ${code}` : `${name} exited ${code}: ${line}`;
}

/** The first version-looking token of a `--version` output (`skillspector, version 2.12.0`). */
export function versionOf(stdout: string): string | null {
  const match = /\d+\.\d+(?:\.\d+)?[\w.+-]*/.exec(stdout);
  return match === null ? null : oneLine(match[0], MAX_ID_CHARS);
}

/** The wider of two network classes (a tool may widen what its config declares, never narrow). */
export function widestNetwork(a: ScanNetwork, b: ScanNetwork | null): ScanNetwork {
  const order: readonly ScanNetwork[] = ["none", "osv-only", "provider"];
  return b === null || order.indexOf(a) >= order.indexOf(b) ? a : b;
}

/** The daemon's environment: the injected one, else `process.env`. */
export function processEnv(): Env {
  return typeof process === "undefined" ? {} : process.env;
}
