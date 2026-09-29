import {
  type Answer,
  type ChoiceAnswer,
  type ChoiceQuestion,
  deriveNoulConfidence,
  err,
  type NoulAnswer,
  ok,
  type Question,
  type Result,
  type ScoreAnswer,
  type ScoreQuestion,
  scoreLevel,
  validateAnswers,
} from "@jevdict/core";

/**
 * How far a provider's probabilities may sum from 1 and still be rescaled. Past this
 * the numbers are not a distribution and the answer is `invalid`.
 */
export const PROBABILITY_SUM_TOLERANCE = 0.1;

/** Below this the sum counts as exactly 1 and the numbers are kept untouched. */
const EXACT_SUM_EPSILON = 1e-9;

/** Reads one provider answer for question `q`; never throws. */
export type AnswerReader = (q: Question, raw: unknown) => Result<Answer, string>;

type Raw = Readonly<Record<string, unknown>>;

/** A plain object (not an array, not null). */
export function isRecord(value: unknown): value is Raw {
  return Object.prototype.toString.call(value) === "[object Object]";
}

function isUnit(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

function distributionProblem(name: string, raw: Raw, keys: readonly string[]): string | null {
  const missing = keys.find((k) => !Object.hasOwn(raw, k));
  if (missing !== undefined) return `${name}: probabilities missing ${missing}`;
  const unknown = Object.keys(raw).find((k) => !keys.includes(k));
  if (unknown !== undefined) return `${name}: unknown probability label ${unknown}`;
  if (!keys.every((k) => isUnit(raw[k]))) return `${name}: probabilities must be in [0, 1]`;
  return null;
}

/**
 * The distribution over exactly `keys`: every key present, no other key, each value a
 * finite number in [0, 1], summing to 1 ± {@link PROBABILITY_SUM_TOLERANCE}, rescaled
 * to sum to 1. Anything else (NaN, missing label, zero sum) is an error value.
 */
export function normalizeProbabilities(
  name: string,
  raw: unknown,
  keys: readonly string[],
): Result<Record<string, number>, string> {
  if (!isRecord(raw)) return err(`${name}: probabilities must be an object`);
  const problem = distributionProblem(name, raw, keys);
  if (problem !== null) return err(problem);
  const values = keys.map((k) => raw[k] as number);
  const sum = values.reduce((a, b) => a + b, 0);
  if (sum <= 0 || Math.abs(sum - 1) > PROBABILITY_SUM_TOLERANCE) {
    return err(`${name}: probabilities sum to ${sum}, not 1`);
  }
  const scale = Math.abs(sum - 1) <= EXACT_SUM_EPSILON ? 1 : sum;
  return ok(Object.fromEntries(keys.map((k, i) => [k, (values[i] as number) / scale])));
}

/** A noul answer from a calibrated `p` alone; it is used as is, confidence 1 (D-038). */
export function readDerivedNoul(name: string, p: unknown): Result<NoulAnswer, string> {
  if (!isUnit(p)) return err(`${name}: p must be in [0, 1]`);
  return ok({ kind: "noul", p, confidence: deriveNoulConfidence(p) });
}

/**
 * A noul answer with a self-reported confidence (LLM providers): `p` and `confidence`
 * are taken as given and go through the engine's confidence routing (D-038). The
 * deterministic floor, not this reader, bounds a badly calibrated provider.
 */
export function readReportedNoul(
  name: string,
  p: unknown,
  confidence: unknown,
): Result<NoulAnswer, string> {
  if (!isUnit(p)) return err(`${name}: p must be in [0, 1]`);
  if (!isUnit(confidence)) return err(`${name}: confidence must be in [0, 1]`);
  return ok({ kind: "noul", p, confidence });
}

/** A choice answer; `p` is the normalized probability of the chosen option. */
export function readChoice(q: ChoiceQuestion, raw: unknown): Result<ChoiceAnswer, string> {
  if (!isRecord(raw)) return err(`${q.name}: answer must be an object`);
  const { choice, confidence } = raw;
  if (typeof choice !== "string" || !Object.hasOwn(q.options, choice)) {
    return err(`${q.name}: choice ${String(choice)} is not an option`);
  }
  if (!isUnit(confidence)) return err(`${q.name}: confidence must be in [0, 1]`);
  const probabilities = normalizeProbabilities(q.name, raw.probabilities, Object.keys(q.options));
  if (!probabilities.ok) return probabilities;
  const p = probabilities.value[choice] as number;
  return ok({ kind: "choice", choice, p, confidence, probabilities: probabilities.value });
}

/** A score answer; `level` is the rubric label at `round(score)` (core `scoreLevel`). */
export function readScore(q: ScoreQuestion, raw: unknown): Result<ScoreAnswer, string> {
  if (!isRecord(raw)) return err(`${q.name}: answer must be an object`);
  const { score, confidence } = raw;
  const top = q.rubric.length - 1;
  if (typeof score !== "number" || !Number.isFinite(score) || score < 0 || score > top) {
    return err(`${q.name}: score must be in [0, ${top}]`);
  }
  if (!isUnit(confidence)) return err(`${q.name}: confidence must be in [0, 1]`);
  const keys = q.rubric.map((_, i) => String(i));
  const probabilities = normalizeProbabilities(q.name, raw.probabilities, keys);
  if (!probabilities.ok) return probabilities;
  const level = scoreLevel(q.rubric, score);
  return ok({ kind: "score", score, level, confidence, probabilities: probabilities.value });
}

/**
 * Every asked question's answer read from `answers` with `read`, then checked by core
 * `validateAnswers`. One missing or unreadable answer fails the whole batch; answers to
 * names that were not asked are dropped. Never throws.
 */
export function collectAnswers(
  questions: readonly Question[],
  answers: unknown,
  read: AnswerReader,
): Result<Record<string, Answer>, string> {
  if (!isRecord(answers)) return err("answers must be an object keyed by question name");
  const results = questions.map((q) =>
    Object.hasOwn(answers, q.name)
      ? ([q.name, read(q, answers[q.name])] as const)
      : ([q.name, err(`${q.name}: no answer`)] as const),
  );
  const problems = results.flatMap(([, r]) => (r.ok ? [] : [r.error]));
  if (problems.length > 0) return err(problems.join("; "));
  const out = Object.fromEntries(
    results.map(([name, r]) => [name, (r as { value: Answer }).value]),
  );
  const invalid = validateAnswers(questions, out);
  return invalid.length > 0 ? err(invalid.join("; ")) : ok(out);
}
