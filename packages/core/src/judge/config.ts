/** Bounds on the state a judge sees, so one event can never send an unbounded payload. */
export interface JudgeStateConfig {
  /** Most recent case-file calls included in the summary. */
  recentCalls: number;
  /** Trailing window the recent calls are taken from. */
  recentWindowMs: number;
  /** Longest string (raw input, command, task) before it is cut with `…`. */
  maxChars: number;
  /** Longest command line per recent call. */
  maxCallChars: number;
  /** Longest list (paths, hosts, verbs, hosts seen). */
  maxList: number;
}

/**
 * Every number the judge layer uses (spec §Combination rules 4–5). The policy config
 * embeds this as `judge`, so `DEFAULT_POLICY_CONFIG` stays the single place to tune.
 */
export interface JudgeConfig {
  /** Over this the judge counts as "no answer" (spec: 10 seconds). */
  timeoutMs: number;
  /** At most this many questions per event, in one batched request. */
  maxQuestions: number;
  cache: {
    /** Cached answers expire after this (spec: 10 minutes). */
    ttlMs: number;
    /** LRU bound on cached results. */
    maxEntries: number;
  };
  state: JudgeStateConfig;
}

const MINUTE_MS = 60_000;

/** Spec defaults. Frozen: callers derive variants by spreading. */
export const DEFAULT_JUDGE_CONFIG: Readonly<JudgeConfig> = Object.freeze({
  timeoutMs: 10_000,
  maxQuestions: 4,
  cache: Object.freeze({ ttlMs: 10 * MINUTE_MS, maxEntries: 1_000 }),
  state: Object.freeze({
    recentCalls: 10,
    recentWindowMs: 5 * MINUTE_MS,
    maxChars: 4_000,
    maxCallChars: 200,
    maxList: 50,
  }),
});
