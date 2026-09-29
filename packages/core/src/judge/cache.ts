import { canonicalJson, sha256Hex } from "../normalizer/hash.ts";
import { DEFAULT_JUDGE_CONFIG } from "./config.ts";
import type { Answer, Judge, JudgeResult, JudgeState, Question } from "./types.ts";

/** Cache bounds and clock; each defaults to the spec value and `Date.now`. */
export interface CacheOptions {
  ttlMs?: number;
  maxEntries?: number;
  now?: () => number;
}

type Success = Extract<JudgeResult, { ok: true }>;

interface Entry {
  at: number;
  result: Success;
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

/**
 * Cache key: the normalized state hash (spec: "cached by normalized state hash"), the
 * case-file task, and a hash of the questions sorted by name (kind, text, options,
 * rubric included). Nothing else from the state is keyed, so the same action asked the
 * same questions for the same task reuses its answers within the TTL.
 */
export function cacheKey(state: JudgeState, questions: readonly Question[]): string {
  const sorted = [...questions].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return sha256Hex(canonicalJson({ state: state.stateHash, task: state.task, questions: sorted }));
}

function frozenCopy(result: Success): Success {
  const answers: Record<string, Answer> = structuredClone(result.answers);
  return deepFreeze({ ...result, answers });
}

/**
 * Wraps `judge` with a TTL + LRU cache of successful results (spec: 10 minutes; bounded
 * at 1000 entries). A hit is returned frozen with `cached: true` and `latencyMs: 0`;
 * errors are never cached, so a timeout is retried on the next event.
 */
export function withCache(judge: Judge, opts: CacheOptions = {}): Judge {
  const ttlMs = opts.ttlMs ?? DEFAULT_JUDGE_CONFIG.cache.ttlMs;
  const maxEntries = opts.maxEntries ?? DEFAULT_JUDGE_CONFIG.cache.maxEntries;
  const now = opts.now ?? Date.now;
  const entries = new Map<string, Entry>();

  const lookup = (key: string): Success | null => {
    const entry = entries.get(key);
    if (entry === undefined) return null;
    entries.delete(key);
    if (now() - entry.at >= ttlMs) return null;
    entries.set(key, entry);
    return entry.result;
  };

  const store = (key: string, result: Success): void => {
    if (maxEntries <= 0) return;
    while (entries.size >= maxEntries) {
      const oldest = entries.keys().next();
      if (oldest.done === true) break;
      entries.delete(oldest.value);
    }
    entries.set(key, { at: now(), result: frozenCopy(result) });
  };

  return {
    name: judge.name,
    async ask(state, questions, askOpts) {
      const key = cacheKey(state, questions);
      const hit = lookup(key);
      if (hit !== null) return Object.freeze({ ...hit, cached: true, latencyMs: 0 });
      const result = await judge.ask(state, questions, askOpts);
      if (result.ok) store(key, result);
      return result;
    },
  };
}
