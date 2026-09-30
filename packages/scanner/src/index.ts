/**
 * @jev-cops/scanner — security scanners for the skills, plugins and MCP servers an agent
 * installs, behind one {@link Scanner} interface (PLAN-SETUP §4.1). `createScanner` mirrors
 * `@jev-cops/judge`'s `createJudge` (D-004): it never throws at startup; a missing tool
 * yields a scanner whose `scan()` answers `{ verdict: "error" }`, which the daemon's gate
 * turns into a hold, never an allow.
 */
import { createCommandScanner } from "./adapters/command.ts";
import { createNoneScanner } from "./adapters/none.ts";
import { errorResult, type ResultBase, type ScannerDeps } from "./adapters/shared.ts";
import { createSkillspectorScanner } from "./adapters/skillspector.ts";
import type { Scanner, ScannerConfig } from "./types.ts";

export type { CommandConfig } from "./adapters/command.ts";
export { NO_SCANNER } from "./adapters/none.ts";
export { bunWhich, REMOTE_NOT_FETCHED, type ScannerDeps, type Which } from "./adapters/shared.ts";
export {
  extraArgsProblem,
  SKILLSPECTOR_LLM_ENV,
  type SkillspectorConfig,
} from "./adapters/skillspector.ts";
export {
  type CollectedSkill,
  collectSkill,
  contentHash,
  DEFAULT_LIMITS,
  type Materialized,
  type MaterializeLimits,
  materialize,
  type NotebookChange,
  type SkillChange,
  type SkillFile,
  type TextEdit,
  writeMaterialized,
} from "./materialize.ts";
export { oneLine, promptLikeOf, UNREADABLE_OUTPUT } from "./parse.ts";
export {
  type FetchedSource,
  fetchGitSource,
  GIT_CLONE_GUARD,
  isPrivateHost,
  REMOTE_DEADLINE_MS,
  REMOTE_MAX_BYTES,
  type RemoteDeps,
  remoteUrlProblem,
} from "./remote.ts";
export {
  absolutePath,
  MAX_STDOUT_BYTES,
  type RunOutcome,
  type RunRequest,
  runBounded,
  type Spawn,
  STDERR_TAIL_BYTES,
  scanEnv,
} from "./run.ts";
export * from "./types.ts";

/** The schema name a `command` scanner prints (README "The command contract"). */
export const SCAN_SCHEMA = "jev-cops.scan/1";

/** An adapter name no config should carry: every call answers `error` (never `none`). */
function unknownAdapter(adapter: unknown): Scanner {
  const reason = `unknown scanner adapter: ${String(adapter)}`;
  const base: ResultBase = { tool: "unknown", mode: "static", network: "none", version: null };
  return {
    name: "command",
    available: async () => ({ ok: false, reason }),
    scan: async () => errorResult(base, reason, performance.now()),
  };
}

/**
 * The scanner for `config`: `none`, `skillspector` (static by default: `--no-llm`) or
 * `command` (any tool printing `jev-cops.scan/1`). Never throws. The tool is looked up at
 * each call, on the absolute entries of the daemon's `PATH`, so one installed after the
 * daemon started is found without a restart. An unknown adapter (a config that skipped
 * validation) answers `error` on every call rather than passing for `none`.
 */
export function createScanner(config: ScannerConfig, deps: ScannerDeps = {}): Scanner {
  switch (config.adapter) {
    case "none":
      return createNoneScanner();
    case "skillspector":
      return createSkillspectorScanner(config, deps);
    case "command":
      return createCommandScanner(config, deps);
    default:
      return unknownAdapter((config as { adapter?: unknown }).adapter);
  }
}
