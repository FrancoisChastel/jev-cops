import { type Answer, type Question, scoreLevel } from "./types.ts";

function isProbability(value: unknown): boolean {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Object.prototype.toString.call(value) === "[object Object]";
}

function probabilityProblems(name: string, probabilities: unknown): string[] {
  if (!isRecord(probabilities)) return [`${name}: probabilities must be an object`];
  const bad = Object.values(probabilities).some((v) => !isProbability(v));
  return bad ? [`${name}: probabilities must be in [0, 1]`] : [];
}

function kindProblems(q: Question, a: Answer): string[] {
  switch (q.kind) {
    case "noul":
      return isProbability((a as { p?: unknown }).p) ? [] : [`${q.name}: p must be in [0, 1]`];
    case "choice": {
      const c = a as Extract<Answer, { kind: "choice" }>;
      const option = typeof c.choice === "string" && Object.hasOwn(q.options, c.choice);
      return [
        ...(option ? [] : [`${q.name}: choice ${String(c.choice)} is not an option`]),
        ...(isProbability(c.p) ? [] : [`${q.name}: p must be in [0, 1]`]),
        ...probabilityProblems(q.name, c.probabilities),
      ];
    }
    case "score": {
      const s = a as Extract<Answer, { kind: "score" }>;
      const top = q.rubric.length - 1;
      if (
        typeof s.score !== "number" ||
        !Number.isFinite(s.score) ||
        s.score < 0 ||
        s.score > top
      ) {
        return [`${q.name}: score must be in [0, ${top}]`];
      }
      const expected = scoreLevel(q.rubric, s.score);
      const level =
        s.level === expected
          ? []
          : [`${q.name}: level ${String(s.level)} does not match score ${s.score} (${expected})`];
      return [...level, ...probabilityProblems(q.name, s.probabilities)];
    }
  }
}

function answerProblems(q: Question, a: unknown): string[] {
  if (!isRecord(a)) return [`${q.name}: no answer`];
  if (a.kind !== q.kind) return [`${q.name}: expected a ${q.kind} answer, got ${String(a.kind)}`];
  const confidence = isProbability(a.confidence) ? [] : [`${q.name}: confidence must be in [0, 1]`];
  return [...confidence, ...kindProblems(q, a as unknown as Answer)];
}

/**
 * Problems with a provider's answers to `questions`: a missing answer, a kind mismatch,
 * a number outside [0, 1], a choice outside the options, a score outside the rubric or
 * a level that is not the rubric label at `round(score)`. Empty when all are usable.
 * Answers to names that were not asked are ignored.
 */
export function validateAnswers(
  questions: readonly Question[],
  answers: Readonly<Record<string, unknown>>,
): string[] {
  return questions.flatMap((q) =>
    answerProblems(q, Object.hasOwn(answers, q.name) ? answers[q.name] : undefined),
  );
}

/** Problems with a question batch: over `max` questions, duplicate or empty names, empty text. */
export function validateQuestions(questions: readonly Question[], max: number): string[] {
  if (questions.length > max) {
    return [`${questions.length} questions asked, at most ${max} allowed`];
  }
  const seen = new Set<string>();
  return questions.flatMap((q, i) => {
    const problems: string[] = [];
    if (q.name === "") problems.push(`question ${i}: empty name`);
    else if (seen.has(q.name)) problems.push(`duplicate question name: ${q.name}`);
    if (q.text.trim() === "") problems.push(`question ${i}: empty text`);
    seen.add(q.name);
    return problems;
  });
}

/** Only the answers to `questions`, deep-copied, so a caller never shares a provider's objects. */
export function pickAnswers(
  questions: readonly Question[],
  answers: Readonly<Record<string, Answer>>,
): Record<string, Answer> {
  return Object.fromEntries(
    questions
      .filter((q) => Object.hasOwn(answers, q.name))
      .map((q) => [q.name, structuredClone(answers[q.name] as Answer)]),
  );
}
