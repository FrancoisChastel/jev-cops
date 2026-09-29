import { posix } from "node:path";
import { budgetStatus } from "../context/budget.ts";
import { type ContextConfig, deepFreeze } from "../context/config.ts";
import type { FeatureResult } from "../context/features.ts";
import { secretPathReads } from "../context/record.ts";
import { hostAllowed, type RepoHints, taskAllowlist } from "../context/scope.ts";
import { type SequenceMatch, sequenceScore } from "../context/sequence.ts";
import { taintFraction, tokenTaint } from "../context/taint.ts";
import type { CaseFile } from "../context/types.ts";
import type { NormalizedEvent } from "../normalizer/types.ts";
import { parseDuration } from "./duration.ts";
import type {
  BudgetView,
  CaseFileView,
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
 * are computed on first use.
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
  });
}
