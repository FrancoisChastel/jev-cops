import {
  type Answer,
  err,
  type Judge,
  type JudgeResult,
  type JudgeState,
  ok,
  type Question,
  type Result,
} from "@jevdict/core";
import { isRecord } from "../answers.ts";
import {
  ANSWER_SCHEMA_NAME,
  buildAnswerSchema,
  buildPrompt,
  type JsonObject,
  parseLlmAnswers,
} from "../prompt.ts";
import { errorMessage, type FetchLike, failure, isAbort, redact } from "../shared.ts";

/** OpenRouter API root used unless the config names another. */
export const OPENROUTER_DEFAULT_BASE_URL = "https://openrouter.ai/api/v1";
/** Environment variable the factory reads the OpenRouter key from. */
export const OPENROUTER_API_KEY_ENV = "OPENROUTER_API_KEY";
/** `HTTP-Referer` attribution header sent unless the config names another. */
export const OPENROUTER_DEFAULT_REFERER = "https://github.com/FrancoisChastel/jevdict";
/** `X-Title` attribution header sent unless the config names another. */
export const OPENROUTER_DEFAULT_TITLE = "jevdict";

/** What the OpenRouter provider needs; the key is already resolved by the factory. */
export interface OpenRouterOptions {
  readonly apiKey: string;
  /** A model that supports structured outputs, e.g. `openai/gpt-5-mini`. */
  readonly model: string;
  readonly baseURL?: string;
  readonly fetch?: FetchLike;
  readonly referer?: string;
  readonly title?: string;
}

/**
 * The chat-completions body: constant system text, the state and questions as the user
 * message, a strict `json_schema` response format, `temperature: 0`, and
 * `require_parameters` so OpenRouter only routes to a provider that honours the schema.
 */
export function buildOpenRouterBody(
  state: JudgeState,
  questions: readonly Question[],
  model: string,
): JsonObject {
  const { system, user } = buildPrompt(state, questions);
  return {
    model,
    temperature: 0,
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
    response_format: {
      type: "json_schema",
      json_schema: { name: ANSWER_SCHEMA_NAME, strict: true, schema: buildAnswerSchema(questions) },
    },
    provider: { require_parameters: true },
  };
}

interface Completion {
  readonly model: string | null;
  readonly answers: Record<string, Answer>;
}

function messageContent(body: unknown): unknown {
  if (!isRecord(body) || !Array.isArray(body.choices)) return undefined;
  const [first] = body.choices as unknown[];
  if (!isRecord(first) || !isRecord(first.message)) return undefined;
  return first.message.content;
}

/**
 * Answers from a chat-completions body: `choices[0].message.content` parsed as JSON by
 * `parseLlmAnswers` (self-reported confidence, taken as given, D-038). Never throws.
 */
export function readOpenRouterBody(
  body: unknown,
  questions: readonly Question[],
): Result<Completion, string> {
  const content = messageContent(body);
  if (typeof content !== "string") return err("openrouter response has no message content");
  const answers = parseLlmAnswers(content, questions);
  if (!answers.ok) return answers;
  const model = isRecord(body) && typeof body.model === "string" ? body.model : null;
  return ok({ model, answers: answers.value });
}

/** 401/403 → `invalid` (bad key); 408/429/5xx → `unreachable`; other statuses → `invalid`. */
function classifyStatus(status: number, started: number): JudgeResult {
  if (status === 401 || status === 403) {
    return failure("invalid", `openrouter rejected the API key (HTTP ${status})`, started);
  }
  if (status === 408 || status === 429 || status >= 500) {
    return failure("unreachable", `openrouter HTTP ${status}`, started);
  }
  return failure("invalid", `openrouter HTTP ${status}`, started);
}

function headers(opts: OpenRouterOptions): Record<string, string> {
  return {
    Authorization: `Bearer ${opts.apiKey}`,
    "Content-Type": "application/json",
    "HTTP-Referer": opts.referer ?? OPENROUTER_DEFAULT_REFERER,
    "X-Title": opts.title ?? OPENROUTER_DEFAULT_TITLE,
  };
}

type Sent = { ok: true; body: unknown } | { ok: false; result: JudgeResult };

async function send(
  opts: OpenRouterOptions,
  body: JsonObject,
  signal: AbortSignal | undefined,
  started: number,
): Promise<Sent> {
  const doFetch: FetchLike = opts.fetch ?? ((url, init) => fetch(url, init));
  const url = `${(opts.baseURL ?? OPENROUTER_DEFAULT_BASE_URL).replace(/\/+$/, "")}/chat/completions`;
  const init = { method: "POST", headers: headers(opts), body: JSON.stringify(body) };
  let response: Response;
  try {
    response = await doFetch(url, signal === undefined ? init : { ...init, signal });
  } catch (cause) {
    if (isAbort(cause, signal)) {
      return { ok: false, result: failure("timeout", "openrouter request aborted", started) };
    }
    const detail = redact(`openrouter unreachable: ${errorMessage(cause)}`, opts.apiKey);
    return { ok: false, result: failure("unreachable", detail, started) };
  }
  if (!response.ok) return { ok: false, result: classifyStatus(response.status, started) };
  try {
    return { ok: true, body: (await response.json()) as unknown };
  } catch (cause) {
    const kind = isAbort(cause, signal) ? "timeout" : "invalid";
    return { ok: false, result: failure(kind, "openrouter response is not JSON", started) };
  }
}

/**
 * OpenRouter as a core {@link Judge}: plain `fetch`, no vendor SDK, one request per
 * batch. Confidence is self-reported by the model (no logprobs), so it is less
 * calibrated than Jev; the deterministic floor is what limits the damage (D-004).
 * The key never appears in a result detail. Never throws.
 */
export function createOpenRouterJudge(opts: OpenRouterOptions): Judge {
  return {
    name: "openrouter",
    async ask(state, questions, askOpts = {}) {
      const started = performance.now();
      const body = buildOpenRouterBody(state, questions, opts.model);
      const sent = await send(opts, body, askOpts.signal, started);
      if (!sent.ok) return sent.result;
      const completion = readOpenRouterBody(sent.body, questions);
      if (!completion.ok) return failure("invalid", completion.error, started);
      return {
        ok: true,
        answers: completion.value.answers,
        provider: "openrouter",
        model: completion.value.model ?? opts.model,
        cached: false,
        latencyMs: performance.now() - started,
      };
    },
  };
}
