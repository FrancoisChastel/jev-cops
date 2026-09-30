import type { Judge, JudgeResult, Question } from "@jev-cops/core";
import { generateText, type LanguageModel, NoObjectGeneratedError, Output } from "ai";
import { z } from "zod";
import { ANSWER_SCHEMA_NAME, buildPrompt, parseLlmAnswers } from "../prompt.ts";
import { errorMessage, failure, isAbort } from "../shared.ts";

/**
 * A language-model instance the caller constructs (e.g. from `@ai-sdk/openai`). A bare
 * model-id string is excluded: it would route through the AI SDK's global default
 * provider, sending judge state somewhere the config does not name (T13).
 */
export type VercelAiModel = Exclude<LanguageModel, string>;

/** What the Vercel AI SDK provider needs: bring your own model. */
export interface VercelAiOptions {
  readonly model: VercelAiModel;
}

const unit = z.number().min(0).max(1);

function distribution(keys: readonly string[]): z.ZodType {
  return z.strictObject(Object.fromEntries(keys.map((k) => [k, unit])));
}

function labelSchema(labels: readonly string[]): z.ZodType {
  const [first, ...rest] = labels;
  return first === undefined ? z.never() : z.enum([first, ...rest]);
}

function questionSchema(q: Question): z.ZodType {
  switch (q.kind) {
    case "noul":
      return z.strictObject({ p: unit, confidence: unit });
    case "choice": {
      const labels = Object.keys(q.options);
      return z.strictObject({
        choice: labelSchema(labels),
        confidence: unit,
        probabilities: distribution(labels),
      });
    }
    case "score": {
      const keys = q.rubric.map((_, i) => String(i));
      return z.strictObject({
        score: z
          .number()
          .min(0)
          .max(q.rubric.length - 1),
        confidence: unit,
        probabilities: distribution(keys),
      });
    }
  }
}

/**
 * The zod twin of `buildAnswerSchema`, generated from the same questions: one closed
 * object per question name, choice labels as an enum, score bounded by the rubric. The
 * AI SDK validates the model's output against it, so a wrong label never parses.
 */
export function buildZodAnswerSchema(questions: readonly Question[]): z.ZodType {
  return z.strictObject(Object.fromEntries(questions.map((q) => [q.name, questionSchema(q)])));
}

function modelName(model: VercelAiModel): string {
  return typeof model.modelId === "string" && model.modelId !== "" ? model.modelId : "unknown";
}

/**
 * A thrown AI SDK error as a judge result: abort → `timeout`; `NoObjectGeneratedError`
 * (output failed to parse or validate) → `invalid`; anything else → `unreachable`.
 */
export function classifyVercelAiError(
  cause: unknown,
  signal: AbortSignal | undefined,
  started: number,
): JudgeResult {
  if (isAbort(cause, signal)) return failure("timeout", "vercel-ai request aborted", started);
  if (NoObjectGeneratedError.isInstance(cause)) {
    return failure("invalid", `vercel-ai: ${errorMessage(cause)}`, started);
  }
  return failure("unreachable", `vercel-ai: ${errorMessage(cause)}`, started);
}

/**
 * The Vercel AI SDK as a core {@link Judge}: `generateText` with `Output.object` over the
 * zod schema, the constant system text as `instructions`, `temperature: 0`,
 * `maxRetries: 0` (the core timeout guard owns the budget) and the caller's signal.
 * Confidence is self-reported by the model. Depends on `ai` only, never a vendor
 * package. Never throws.
 */
export function createVercelAiJudge(opts: VercelAiOptions): Judge {
  const model = modelName(opts.model);
  return {
    name: "vercel-ai",
    async ask(state, questions, askOpts = {}) {
      const started = performance.now();
      const { system, user } = buildPrompt(state, questions);
      try {
        const result = await generateText({
          model: opts.model,
          instructions: system,
          prompt: user,
          output: Output.object({
            schema: buildZodAnswerSchema(questions),
            name: ANSWER_SCHEMA_NAME,
          }),
          temperature: 0,
          maxRetries: 0,
          ...(askOpts.signal !== undefined ? { abortSignal: askOpts.signal } : {}),
        });
        const answers = parseLlmAnswers(result.output, questions);
        if (!answers.ok) return failure("invalid", answers.error, started);
        const latencyMs = performance.now() - started;
        return {
          ok: true,
          answers: answers.value,
          provider: "vercel-ai",
          model,
          cached: false,
          latencyMs,
        };
      } catch (cause) {
        return classifyVercelAiError(cause, askOpts.signal, started);
      }
    },
  };
}
