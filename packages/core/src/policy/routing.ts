import type { Answer, JudgeResult, Question } from "../judge/types.ts";
import type { JevAnswer } from "../schema/verdict.ts";
import type { PolicyConfig } from "./config.ts";
import { clamp01 } from "./floor.ts";
import { qualify, SCOPE_QUESTION } from "./questions.ts";

/** A policy's answers after confidence routing, or why it takes its fallback. */
export type Routed =
  | { kind: "answered"; answers: Record<string, Answer>; capped: boolean }
  | { kind: "fallback"; why: string };

/** Outcome of the engine's own `serves_task` question. */
export interface ScopeRouting {
  status: "not-asked" | "no-answer" | "discarded" | "used" | "capped";
  /** The semantic scope value when used (`p`), else null. */
  value: number | null;
}

function confidenceOf(a: Answer): number {
  return Number.isNaN(a.confidence) ? 0 : a.confidence;
}

function lookup(judged: JudgeResult, name: string, kind: Question["kind"]): Answer | null {
  if (!judged.ok || !Object.hasOwn(judged.answers, name)) return null;
  const answer = judged.answers[name];
  return answer !== undefined && answer.kind === kind ? answer : null;
}

/**
 * Confidence routing for one policy (spec rule 3), keyed back to its own question names.
 * The judge failing (rule 4), a missing answer, or any answer below `discardBelow`
 * means the policy loses its answers and takes its fallback. `capped` is set when any
 * answer is at or below `trustAbove`: the policy's verdict is then capped at `hold`.
 */
export function routePolicyAnswers(
  policyName: string,
  questions: readonly Question[],
  judged: JudgeResult | null,
  cfg: PolicyConfig,
): Routed {
  if (questions.length === 0) return { kind: "answered", answers: {}, capped: false };
  if (judged === null) return { kind: "fallback", why: "judge not called" };
  if (!judged.ok) return { kind: "fallback", why: `judge ${judged.error}` };
  const answers: Record<string, Answer> = {};
  let capped = false;
  for (const q of questions) {
    const a = lookup(judged, qualify(policyName, q.name), q.kind);
    if (a === null) return { kind: "fallback", why: `no answer to ${q.name}` };
    const confidence = confidenceOf(a);
    if (confidence < cfg.confidence.discardBelow) {
      return { kind: "fallback", why: `answer to ${q.name} discarded (confidence ${confidence})` };
    }
    capped ||= confidence <= cfg.confidence.trustAbove;
    answers[q.name] = a;
  }
  return { kind: "answered", answers, capped };
}

/** Routing of the engine's scope question: discarded below 0.5, capped up to 0.8. */
export function routeScopeAnswer(
  scopeAsked: boolean,
  judged: JudgeResult | null,
  cfg: PolicyConfig,
): ScopeRouting {
  if (!scopeAsked) return { status: "not-asked", value: null };
  const a = judged === null ? null : lookup(judged, SCOPE_QUESTION, "noul");
  if (a === null || a.kind !== "noul") return { status: "no-answer", value: null };
  const confidence = confidenceOf(a);
  if (confidence < cfg.confidence.discardBelow) return { status: "discarded", value: null };
  const status = confidence <= cfg.confidence.trustAbove ? "capped" : "used";
  return { status, value: clamp01(a.p, 0) };
}

function pOf(q: Question, a: Answer): number {
  if (a.kind !== "score") return a.p;
  const chosen = a.probabilities[a.level];
  if (typeof chosen === "number") return chosen;
  return q.kind === "score" ? a.score / (q.rubric.length - 1) : 0;
}

/**
 * The `jev` entries of the verdict: one per batch question the judge answered, named as
 * in the batch. `p` is the answer's probability (for a score, of its level).
 */
export function jevEntries(batch: readonly Question[], judged: JudgeResult | null): JevAnswer[] {
  if (judged === null || !judged.ok) return [];
  return batch.flatMap((q) => {
    const a = lookup(judged, q.name, q.kind);
    if (a === null) return [];
    return [
      {
        question: q.name,
        type: q.kind,
        p: clamp01(pOf(q, a), 0),
        confidence: clamp01(confidenceOf(a), 0),
      },
    ];
  });
}
