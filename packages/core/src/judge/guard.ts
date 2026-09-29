import { withCache } from "./cache.ts";
import { DEFAULT_JUDGE_CONFIG, type JudgeConfig } from "./config.ts";
import type { Judge, JudgeErrorKind, JudgeResult } from "./types.ts";
import { pickAnswers, validateAnswers, validateQuestions } from "./validate.ts";

function failure(error: JudgeErrorKind, detail: string, latencyMs: number): JudgeResult {
  return { ok: false, error, detail, latencyMs };
}

function message(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/**
 * Bounds every request by `timeoutMs` (spec: 10 seconds; a per-call `timeoutMs` can only
 * tighten it). Past the limit the provider's signal is aborted and the caller gets
 * `{ ok: false, error: "timeout" }` at once: the late provider promise is detached (its
 * rejection swallowed, its timer cleared) and never holds the event. A provider that
 * throws or rejects is `unreachable`. The caller's own signal also ends the wait.
 */
export function withTimeout(judge: Judge, cfg: { timeoutMs: number }): Judge {
  return {
    name: judge.name,
    async ask(state, questions, opts = {}) {
      const limit = Math.min(cfg.timeoutMs, opts.timeoutMs ?? Number.POSITIVE_INFINITY);
      const started = performance.now();
      const elapsed = () => performance.now() - started;
      const controller = new AbortController();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const onOuterAbort = () => controller.abort();
      opts.signal?.addEventListener("abort", onOuterAbort, { once: true });
      if (opts.signal?.aborted === true) controller.abort();
      const stopped = new Promise<JudgeResult>((resolve) => {
        const stop = () => resolve(failure("timeout", `no answer within ${limit} ms`, elapsed()));
        controller.signal.addEventListener("abort", stop, { once: true });
        if (controller.signal.aborted) stop();
        timer = setTimeout(() => controller.abort(), limit);
      });
      const answered = Promise.resolve()
        .then(() => judge.ask(state, questions, { timeoutMs: limit, signal: controller.signal }))
        .catch((cause: unknown) => failure("unreachable", message(cause), elapsed()));
      try {
        return await Promise.race([answered, stopped]);
      } finally {
        clearTimeout(timer);
        opts.signal?.removeEventListener("abort", onOuterAbort);
        controller.abort();
      }
    },
  };
}

/**
 * Rejects a batch of more than `max` questions (spec: "at most 4 questions, one batched
 * request"), or with duplicate or empty names, as `invalid` without calling the provider.
 */
export function withQuestionLimit(judge: Judge, max: number): Judge {
  return {
    name: judge.name,
    ask(state, questions, opts) {
      const problems = validateQuestions(questions, max);
      if (problems.length > 0) return Promise.resolve(failure("invalid", problems.join("; "), 0));
      return judge.ask(state, questions, opts);
    },
  };
}

/**
 * Turns a provider's malformed success (missing answer, wrong kind, number outside
 * [0, 1], unknown choice, level not matching the score) into `invalid`, and keeps only
 * the answers that were asked for, so nothing unvalidated reaches a policy or the cache.
 */
export function withValidation(judge: Judge): Judge {
  return {
    name: judge.name,
    async ask(state, questions, opts) {
      const result = await judge.ask(state, questions, opts);
      if (!result.ok) return result;
      const problems = validateAnswers(questions, result.answers);
      if (problems.length > 0) return failure("invalid", problems.join("; "), result.latencyMs);
      return { ...result, answers: pickAnswers(questions, result.answers) };
    },
  };
}

/**
 * The judge the policy engine uses: question limit → cache → validation → timeout →
 * provider. Limit first so an oversized batch never touches the cache; the cache before
 * the timeout so a hit is instant; validation inside the cache so only well-formed
 * answers are stored; the timeout innermost so it bounds only the provider call.
 */
export function composeJudge(
  base: Judge,
  cfg: JudgeConfig = DEFAULT_JUDGE_CONFIG,
  now: () => number = Date.now,
): Judge {
  const timed = withTimeout(base, { timeoutMs: cfg.timeoutMs });
  const cached = withCache(withValidation(timed), { ...cfg.cache, now });
  return withQuestionLimit(cached, cfg.maxQuestions);
}
