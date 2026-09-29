import {
  type Answer,
  err,
  type Judge,
  type JudgeAskOptions,
  type JudgeResult,
  type JudgeState,
  type Question,
  type Result,
} from "@jevdict/core";
import {
  APIConnectionError,
  APIError,
  APITimeoutError,
  APIUserAbortError,
  type JsonValue,
  type Questions,
  type RequestOptions,
  type Question as SdkQuestion,
  TypeSafeClient,
} from "@typesafe-ai/sdk";
import { collectAnswers, isRecord, readChoice, readDerivedNoul, readScore } from "../answers.ts";
import { errorMessage, type FetchLike, failure, isAbort, redact } from "../shared.ts";

/** TypeSafe API root used unless the config names another. */
export const JEV_DEFAULT_BASE_URL = "https://api.typesafe.ai";
/** Jev model used unless the config names another. */
export const JEV_DEFAULT_MODEL = "jev-latest";
/** Environment variable the factory reads the TypeSafe key from. */
export const JEV_API_KEY_ENV = "TYPESAFE_API_KEY";

/** What the Jev provider needs; the key is already resolved by the factory. */
export interface JevOptions {
  readonly apiKey: string;
  readonly baseURL?: string;
  readonly model?: string;
  readonly fetch?: FetchLike;
}

function toSdkQuestion(q: Question): SdkQuestion {
  switch (q.kind) {
    case "noul": {
      const { yes, no } = q.criteria ?? {};
      const criteria = {
        ...(yes !== undefined ? { true: yes } : {}),
        ...(no !== undefined ? { false: no } : {}),
      };
      const hasCriteria = yes !== undefined || no !== undefined;
      return { type: "noul", instructions: q.text, ...(hasCriteria ? { criteria } : {}) };
    }
    case "choice":
      return { type: "choice", instructions: q.text, criteria: { ...q.options } };
    case "score":
      return { type: "score", instructions: q.text, criteria: [...q.rubric] };
  }
}

/** Core questions as SDK questions, keyed by name: text → instructions, labels → criteria. */
export function toSdkQuestions(questions: readonly Question[]): Questions {
  return Object.fromEntries(questions.map((q) => [q.name, toSdkQuestion(q)]));
}

/** The judge state as a plain JSON object (it already is JSON; this drops the readonly types). */
function toEntry(state: JudgeState): { [key: string]: JsonValue } {
  return JSON.parse(JSON.stringify(state)) as { [key: string]: JsonValue };
}

function readJevAnswer(q: Question, raw: unknown): Result<Answer, string> {
  if (!isRecord(raw)) return err(`${q.name}: answer must be an object`);
  if (raw.type !== q.kind) {
    return err(`${q.name}: expected a ${q.kind} answer, got ${String(raw.type)}`);
  }
  switch (q.kind) {
    case "noul":
      return readDerivedNoul(q.name, raw.noul);
    case "choice":
      return readChoice(q, raw);
    case "score":
      return readScore(q, raw);
  }
}

/**
 * Core answers from a `/v1/systemone` body. The SDK does not check the body's shape, so
 * it is read as untrusted: noul `p` = `noul` with confidence `abs(2p − 1)` (D-002),
 * choice `p` = the chosen label's probability, score `level` = the rubric label at
 * `round(score)`; probabilities are rescaled to sum to 1. Never throws.
 */
export function readJevBody(
  body: unknown,
  questions: readonly Question[],
): Result<Record<string, Answer>, string> {
  if (!isRecord(body)) return err("jev response is not a JSON object");
  return collectAnswers(questions, body.answers, readJevAnswer);
}

const UNREACHABLE_STATUS = new Set([408, 429]);

function classifyStatus(status: number, started: number): JudgeResult {
  if (status === 401 || status === 403) {
    return failure("invalid", `jev rejected the API key (HTTP ${status})`, started);
  }
  if (UNREACHABLE_STATUS.has(status) || status >= 500) {
    return failure("unreachable", `jev HTTP ${status}`, started);
  }
  return failure("invalid", `jev HTTP ${status}`, started);
}

/**
 * A thrown SDK error as a judge result: caller abort or the SDK's own timeout →
 * `timeout`; connection failure → `unreachable`; HTTP 401/403 and other 4xx →
 * `invalid`, 408/429/5xx → `unreachable`; anything else → `invalid`. The key is
 * redacted from every detail.
 */
export function classifyJevError(
  cause: unknown,
  signal: AbortSignal | undefined,
  started: number,
  apiKey: string,
): JudgeResult {
  const result = ((): JudgeResult => {
    if (cause instanceof APIUserAbortError || cause instanceof APITimeoutError) {
      return failure("timeout", "jev request aborted or timed out", started);
    }
    if (isAbort(cause, signal)) return failure("timeout", "jev request aborted", started);
    if (cause instanceof APIConnectionError) {
      return failure("unreachable", `jev unreachable: ${errorMessage(cause)}`, started);
    }
    if (cause instanceof APIError) return classifyStatus(cause.status, started);
    return failure("invalid", `jev error: ${errorMessage(cause)}`, started);
  })();
  return result.ok ? result : { ...result, detail: redact(result.detail, apiKey) };
}

function requestOptions(opts: JudgeAskOptions): RequestOptions {
  return {
    ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
    ...(opts.timeoutMs !== undefined ? { timeout: Math.max(1, opts.timeoutMs) } : {}),
  };
}

function createClient(opts: JevOptions, model: string): TypeSafeClient {
  return new TypeSafeClient({
    apiKey: opts.apiKey,
    baseURL: opts.baseURL ?? JEV_DEFAULT_BASE_URL,
    defaultModel: model,
    retry: { maxRetries: 0 },
    logLevel: "off",
    ...(opts.fetch !== undefined ? { fetch: opts.fetch } : {}),
  });
}

function brokenClient(detail: string): Judge {
  return {
    name: "jev",
    ask: () => Promise.resolve({ ok: false, error: "invalid", detail, latencyMs: 0 }),
  };
}

/**
 * TypeSafe Jev as a core {@link Judge}: one `systemOne` request per batch with the
 * state sent as-is. SDK retries are off (`maxRetries: 0`) so one attempt fits the 10 s
 * budget the core timeout guard enforces; SDK logging is off so no body is printed;
 * base URL and model come from config only, never from `TYPESAFE_*` env vars (T13).
 * Never throws, including on a bad client configuration.
 */
export function createJevJudge(opts: JevOptions): Judge {
  const model = opts.model ?? JEV_DEFAULT_MODEL;
  let client: TypeSafeClient;
  try {
    client = createClient(opts, model);
  } catch (cause) {
    return brokenClient(redact(`jev client configuration: ${errorMessage(cause)}`, opts.apiKey));
  }
  return {
    name: "jev",
    async ask(state, questions, askOpts = {}) {
      const started = performance.now();
      try {
        const request = { state: toEntry(state), questions: toSdkQuestions(questions) };
        const body: unknown = await client.systemOne(request, requestOptions(askOpts));
        const answers = readJevBody(body, questions);
        if (!answers.ok) return failure("invalid", answers.error, started);
        const served = isRecord(body) && typeof body.model === "string" ? body.model : model;
        const latencyMs = performance.now() - started;
        return {
          ok: true,
          answers: answers.value,
          provider: "jev",
          model: served,
          cached: false,
          latencyMs,
        };
      } catch (cause) {
        return classifyJevError(cause, askOpts.signal, started, opts.apiKey);
      }
    },
  };
}
