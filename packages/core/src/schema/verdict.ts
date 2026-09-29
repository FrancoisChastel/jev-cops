import { z } from "zod";
import type { Result } from "../result.ts";
import { type SchemaError, safeParse } from "./errors.ts";
import { toolInputSchema } from "./event.ts";
import { eventIdSchema } from "./ids.ts";

/** Version tag every verdict response carries; any other value is rejected. */
export const VERDICT_SCHEMA = "jevdict.verdict/1";

/** The verdict ladder, least to most severe. Verdicts only ever move up it. */
export const VERDICTS = ["allow", "annotate", "rewrite", "hold", "deny", "kill"] as const;

/** One rung of {@link VERDICTS}. */
export type Verdict = (typeof VERDICTS)[number];

/** Answer types a semantic judge question can have. */
export const JEV_QUESTION_TYPES = ["noul", "choice", "score"] as const;

/** One of {@link JEV_QUESTION_TYPES}. */
export type JevQuestionType = (typeof JEV_QUESTION_TYPES)[number];

/** Position of `v` on the ladder: 0 for `allow` up to 5 for `kill`. */
export function verdictRank(v: Verdict): number {
  return VERDICTS.indexOf(v);
}

/** Orders two verdicts by severity: negative when `a` is lower, 0 when equal. */
export function compareVerdict(a: Verdict, b: Verdict): number {
  return verdictRank(a) - verdictRank(b);
}

/** The more severe of two verdicts; how later policies combine with earlier ones. */
export function maxVerdict(a: Verdict, b: Verdict): Verdict {
  return compareVerdict(a, b) >= 0 ? a : b;
}

/**
 * Moves `v` up the ladder by `steps`, saturating at `kill`. Throws a RangeError
 * unless `steps` is a non-negative integer, since no caller may lower a verdict.
 */
export function raiseVerdict(v: Verdict, steps: number): Verdict {
  if (!Number.isInteger(steps) || steps < 0) {
    throw new RangeError(`raiseVerdict: steps must be a non-negative integer, got ${steps}`);
  }
  const rank = Math.min(verdictRank(v) + steps, VERDICTS.length - 1);
  return VERDICTS[rank] ?? "kill";
}

/** True for `deny` and `kill`, the verdicts an adapter must fail closed on. */
export function isDenyClass(v: Verdict): boolean {
  return compareVerdict(v, "deny") >= 0;
}

/** A single verdict value, e.g. `"hold"`. */
export const verdictSchema = z.enum(VERDICTS);

const probability = z.number().min(0).max(1);

/** One typed semantic-judge answer as recorded on the verdict. */
export const jevAnswerSchema = z.strictObject({
  question: z.string(),
  type: z.enum(JEV_QUESTION_TYPES),
  p: probability,
  confidence: probability,
});

/** Session risk budget after this event was charged. */
export const budgetSchema = z.strictObject({
  spent: z.number().nonnegative(),
  limit: z.number().nonnegative(),
});

const verdictResponseShape = z.strictObject({
  schema: z.literal(VERDICT_SCHEMA),
  event_id: eventIdSchema,
  verdict: verdictSchema,
  risk: probability,
  reason: z.string(),
  detail: z.string().optional(),
  updated_input: toolInputSchema.nullable(),
  context_note: z.string().nullable(),
  policies: z.array(z.string()),
  features: z.record(z.string(), z.number()),
  jev: z.array(jevAnswerSchema),
  budget: budgetSchema,
});

/**
 * Canonical `jevdict.verdict/1` response. `updated_input` is set exactly when the
 * verdict is `rewrite`, so an adapter never runs a rewrite without its new input.
 * `detail` is optional so a harness-facing response can omit it entirely.
 */
export const verdictResponseSchema = verdictResponseShape.refine(
  (r) => (r.verdict === "rewrite") === (r.updated_input !== null),
  { path: ["updated_input"], message: "updated_input must be set on rewrite and null otherwise" },
);

/** A validated semantic-judge answer; `p` and `confidence` lie in [0, 1]. */
export type JevAnswer = z.output<typeof jevAnswerSchema>;
/** A validated risk budget snapshot. */
export type Budget = z.output<typeof budgetSchema>;
/** A validated `jevdict.verdict/1` response. */
export type VerdictResponse = z.output<typeof verdictResponseSchema>;

/** Validates an untrusted value as a verdict response. Never throws. */
export function parseVerdict(input: unknown): Result<VerdictResponse, SchemaError> {
  return safeParse(verdictResponseSchema, input, VERDICT_SCHEMA);
}
