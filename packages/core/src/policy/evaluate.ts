import type { PolicyConfig } from "./config.ts";
import type { PolicyContext, PolicyDefinition, PolicyEvent } from "./types.ts";

/** Per-session count of `when` budget overruns, keyed by `name@version`. */
export interface WhenTracker {
  /** Records one overrun; returns the session's count for that policy after it. */
  strike(sessionId: string, policyKey: string): number;
  strikes(sessionId: string, policyKey: string): number;
}

/** A policy's prefilter outcome for one event. */
export interface PolicyMatch {
  readonly policy: PolicyDefinition;
  /** `name@version`. */
  readonly key: string;
  readonly matched: boolean;
  readonly whenMs: number;
  readonly whenOverBudget: boolean;
  /** Over budget `degradeAfter` or more times this session. */
  readonly degraded: boolean;
  /** Set when `when` threw or returned a non-boolean; the policy then counts as matched. */
  readonly error: string | null;
}

/** What {@link evaluatePolicies} needs besides the policies, event and context. */
export interface EvaluateOptions {
  tracker: WhenTracker;
  sessionId: string;
  config: PolicyConfig;
  /** High-resolution clock in ms; `performance.now` by default. */
  clock?: () => number;
}

/** `name@version`, the id a policy carries in traces and verdicts. */
export function policyKey(p: Pick<PolicyDefinition, "name" | "version">): string {
  return `${p.name}@${p.version}`;
}

/**
 * An in-memory tracker bounded to `maxSessions` sessions; the least recently used
 * session is forgotten first. Counts only ever grow within a session.
 */
export function createWhenTracker(maxSessions: number): WhenTracker {
  const sessions = new Map<string, Map<string, number>>();
  const touch = (sessionId: string): Map<string, number> => {
    const counts = sessions.get(sessionId) ?? new Map<string, number>();
    sessions.delete(sessionId);
    sessions.set(sessionId, counts);
    while (sessions.size > maxSessions) {
      const oldest = sessions.keys().next();
      if (oldest.done === true) break;
      sessions.delete(oldest.value);
    }
    return counts;
  };
  return {
    strike(sessionId, key) {
      const counts = touch(sessionId);
      const next = (counts.get(key) ?? 0) + 1;
      counts.set(key, next);
      return next;
    },
    strikes: (sessionId, key) => sessions.get(sessionId)?.get(key) ?? 0,
  };
}

function runWhen(
  p: PolicyDefinition,
  e: PolicyEvent,
  ctx: PolicyContext,
): { value: boolean; error: string | null } {
  try {
    const value: unknown = p.when(e, ctx);
    if (typeof value === "boolean") return { value, error: null };
    return { value: true, error: `when returned ${typeof value}, not a boolean` };
  } catch (cause) {
    const text = cause instanceof Error ? cause.message : String(cause);
    return { value: true, error: `when threw: ${text}` };
  }
}

/**
 * Runs every policy's `when` prefilter, timing each one. Fails toward asking, never
 * toward allowing: a `when` over the budget (spec: 2 ms), one that throws, or one that
 * returns a non-boolean counts as matched for this event, and the overrun is traced; the
 * `degradeAfter`th overrun in a session marks the policy degraded for `doctor`.
 */
export function evaluatePolicies(
  policies: ReadonlyArray<PolicyDefinition>,
  e: PolicyEvent,
  ctx: PolicyContext,
  opts: EvaluateOptions,
): PolicyMatch[] {
  const clock = opts.clock ?? (() => performance.now());
  const { budgetMs, degradeAfter } = opts.config.when;
  return policies.map((policy) => {
    const key = policyKey(policy);
    const started = clock();
    const outcome = runWhen(policy, e, ctx);
    const whenMs = clock() - started;
    const whenOverBudget = whenMs > budgetMs;
    const strikes = whenOverBudget
      ? opts.tracker.strike(opts.sessionId, key)
      : opts.tracker.strikes(opts.sessionId, key);
    return {
      policy,
      key,
      matched: outcome.value || whenOverBudget,
      whenMs,
      whenOverBudget,
      degraded: strikes >= degradeAfter,
      error: outcome.error,
    };
  });
}
