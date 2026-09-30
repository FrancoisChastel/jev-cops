import { posix } from "node:path";
import { budgetStatus } from "../context/budget.ts";
import { type ContextConfig, deepFreeze } from "../context/config.ts";
import { defaultBranches, isOnDefaultBranch } from "../context/environment.ts";
import type { FeatureResult } from "../context/features.ts";
import { secretPathReads } from "../context/record.ts";
import { hostAllowed, type RepoHints, taskAllowlist } from "../context/scope.ts";
import { type SequenceMatch, sequenceScore } from "../context/sequence.ts";
import { taintFraction, tokenTaint } from "../context/taint.ts";
import type { CaseFile } from "../context/types.ts";
import { expandHome } from "../normalizer/paths.ts";
import type { NormalizedEvent } from "../normalizer/types.ts";
import { parseDuration } from "./duration.ts";
import type {
  BudgetView,
  CaseFileView,
  EnvView,
  PolicyConfigView,
  PolicyContext,
  ScopeView,
  SequenceView,
  TaintView,
} from "./types.ts";

/** What the engine knows about an event when it builds the policy context. */
export interface PolicyContextInputs {
  n: NormalizedEvent;
  cf: CaseFile;
  features: FeatureResult;
  floor: number;
  contextConfig: ContextConfig;
  repoHints?: RepoHints;
  /** `~`/`$HOME` for this call (the daemon's); default `contextConfig.home`. */
  home?: string;
  /** `[policy] protectedPaths` as configured; default none. */
  protectedPaths?: readonly string[];
  /** `[policy] privatePaths` as configured (`!` exemptions included); default none. */
  privatePaths?: readonly string[];
}

function isUnder(path: string, root: string): boolean {
  return path === root || path.startsWith(root === "/" ? "/" : `${root}/`);
}

function lazy<T>(compute: () => T): () => T {
  let value: { v: T } | undefined;
  return () => {
    value ??= { v: compute() };
    return value.v;
  };
}

function sequenceView(inputs: PolicyContextInputs): SequenceView {
  const { n, cf, contextConfig } = inputs;
  const matches = lazy((): SequenceMatch[] => sequenceScore(n, cf, contextConfig).matches);
  return {
    secretReadWithin: (window) => {
      const since = cf.now() - parseDuration(window);
      const past = cf.secretReadsSince(since).some((r) => r.callId !== n.event.call.id);
      return past || secretPathReads(n, cf.now(), contextConfig).length > 0;
    },
    matched: (name) => matches().some((m) => m.name === name),
    score: inputs.features.features.sequence,
  };
}

function scopeView(inputs: PolicyContextInputs): ScopeView {
  const { n, cf, contextConfig } = inputs;
  const allowlist = taskAllowlist(cf.task, inputs.repoHints, contextConfig);
  const cwd = n.event.call.cwd;
  const root = n.event.env?.git?.repo ?? cwd;
  return {
    hostAllowed: (host) => typeof host === "string" && host !== "" && hostAllowed(host, allowlist),
    pathInRepo: (path) => isUnder(posix.resolve(cwd, path), root),
    score: inputs.features.features.scope,
    unsure: inputs.features.scopeUnsure,
    allowlist,
  };
}

function taintView(inputs: PolicyContextInputs): TaintView {
  const { n, cf, contextConfig } = inputs;
  return {
    of: (token) => tokenTaint(token, n, cf, contextConfig),
    fraction: taintFraction(n, cf, contextConfig).value,
  };
}

function casefileView(cf: CaseFile): CaseFileView {
  return {
    sessionId: cf.sessionId,
    recentCalls: (within) => cf.recentCalls(parseDuration(within)),
    secretReadsWithin: (within) => cf.secretReadsSince(cf.now() - parseDuration(within)),
    hostsSeen: () => cf.hostsSeen(),
    filesWritten: () => cf.filesWritten(),
    failuresInARow: () => cf.failuresInARow(),
  };
}

function envView(n: NormalizedEvent, cfg: ContextConfig): EnvView {
  const git = n.event.env?.git;
  return {
    defaultBranches: defaultBranches(git, cfg),
    onDefaultBranch: isOnDefaultBranch(git, cfg),
  };
}

/** `~`/`$HOME` expanded; absolute ones normalized; relative ones kept; empty ones dropped. */
function protectedPathsOf(paths: readonly string[], home: string): string[] {
  return paths
    .map((p) => expandHome(p.trim(), home))
    .filter((p) => p !== "")
    .map((p) => {
      const normal = p.startsWith("/") ? posix.normalize(p) : p;
      return normal.length > 1 ? normal.replace(/\/+$/, "") : normal;
    });
}

/** Absolute private paths and `!` exemptions, `~` expanded; relative and empty ones dropped. */
function privatePathsOf(paths: readonly string[], home: string): string[] {
  return paths.flatMap((p) => {
    const exempt = p.trim().startsWith("!");
    const [path] = protectedPathsOf([p.trim().slice(exempt ? 1 : 0)], home);
    return path?.startsWith("/") === true ? [exempt ? `!${path}` : path] : [];
  });
}

function configView(inputs: PolicyContextInputs): PolicyConfigView {
  const home = inputs.home ?? inputs.contextConfig.home;
  return {
    home,
    protectedPaths: protectedPathsOf(inputs.protectedPaths ?? [], home),
    privatePaths: privatePathsOf(inputs.privatePaths ?? [], home),
  };
}

function budgetView(cf: CaseFile, cfg: ContextConfig): BudgetView {
  const { spent, limit } = cf.budget;
  const status = budgetStatus(cf.budget, cfg.budget);
  const ratio = limit <= 0 ? 1 : spent / limit;
  return { spent, limit, ratio, raiseSteps: status.raiseSteps, holdAll: status.holdAll };
}

/**
 * The frozen `ctx` a policy receives. Every helper reads the case file, never writes
 * it: the case-file view exposes queries only, `session.task` is the case file's task
 * (T11), and the budget is a snapshot before this event is charged. Sequence matches
 * are computed on first use. `env` answers the default-branch question (D-068) and
 * `config` carries the daemon's home, protected paths and private paths.
 */
export function buildPolicyContext(inputs: PolicyContextInputs): PolicyContext {
  const { n, cf } = inputs;
  return deepFreeze({
    session: {
      id: n.event.session.id,
      task: cf.task,
      mode: n.event.session.mode ?? null,
      parentId: n.event.session.parent_id,
    },
    features: { ...inputs.features.features },
    floor: inputs.floor,
    sequence: sequenceView(inputs),
    scope: scopeView(inputs),
    taint: taintView(inputs),
    casefile: casefileView(cf),
    budget: budgetView(cf, inputs.contextConfig),
    env: envView(n, inputs.contextConfig),
    config: configView(inputs),
  });
}
