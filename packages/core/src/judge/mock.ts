import type {
  Answer,
  Judge,
  JudgeAskOptions,
  JudgeErrorKind,
  JudgeResult,
  JudgeState,
  Question,
} from "./types.ts";
import { pickAnswers, validateAnswers } from "./validate.ts";

/** Fixed answers by question name, or a function computing them per request. */
export type MockScript =
  | Readonly<Record<string, Answer>>
  | ((state: JudgeState, questions: readonly Question[]) => Readonly<Record<string, Answer>>);

/** Mock behaviour: an artificial delay, a scripted failure, provider/model names. */
export interface MockJudgeOptions {
  delayMs?: number;
  fail?: JudgeErrorKind;
  name?: string;
  model?: string;
}

/** Resolves to true when `signal` aborted before `ms` elapsed; never keeps a timer alive. */
function sleep(ms: number, signal: AbortSignal | undefined): Promise<boolean> {
  if (signal?.aborted === true) return Promise.resolve(true);
  return new Promise((resolve) => {
    const onAbort = () => {
      clearTimeout(timer);
      resolve(true);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve(false);
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function failure(error: JudgeErrorKind, detail: string, started: number): JudgeResult {
  return { ok: false, error, detail, latencyMs: performance.now() - started };
}

/**
 * A judge that answers from `script`, for tests and fixtures (spec: "fixtures replace
 * Jev answers with recorded ones"). A question with no scripted answer, or an answer
 * of the wrong kind or out of range, makes the whole batch `invalid`. Honours `signal`.
 */
export function createMockJudge(script: MockScript, opts: MockJudgeOptions = {}): Judge {
  const name = opts.name ?? "mock";
  return {
    name,
    async ask(state, questions, askOpts: JudgeAskOptions = {}) {
      const started = performance.now();
      if (opts.delayMs !== undefined && (await sleep(opts.delayMs, askOpts.signal))) {
        return failure("timeout", "aborted while waiting", started);
      }
      if (opts.fail !== undefined) return failure(opts.fail, "scripted failure", started);
      const scripted = typeof script === "function" ? script(state, questions) : script;
      const missing = questions.filter((q) => !Object.hasOwn(scripted, q.name));
      if (missing.length > 0) {
        const names = missing.map((q) => q.name).join(", ");
        return failure("invalid", `no scripted answer for: ${names}`, started);
      }
      const problems = validateAnswers(questions, scripted);
      if (problems.length > 0) return failure("invalid", problems.join("; "), started);
      return {
        ok: true,
        answers: pickAnswers(questions, scripted),
        provider: name,
        model: opts.model ?? "scripted",
        cached: false,
        latencyMs: performance.now() - started,
      };
    },
  };
}

/** The judge when the semantic layer is switched off: every request is `disabled`. */
export function createDisabledJudge(): Judge {
  return {
    name: "disabled",
    ask: () =>
      Promise.resolve({
        ok: false,
        error: "disabled",
        detail: "semantic judge disabled by config",
        latencyMs: 0,
      }),
  };
}
