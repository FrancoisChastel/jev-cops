import type { ChoiceQuestion, NoulQuestion, ScoreQuestion } from "@jev-cops/core";

/** Yes/no criteria shown to the judge next to a noul question. */
export interface NoulCriteria {
  readonly yes?: string;
  readonly no?: string;
}

function checkHead(name: string, text: string): void {
  if (name.trim() === "") throw new TypeError("question name must be non-empty");
  if (text.trim() === "") throw new TypeError(`question ${name}: text must be non-empty`);
}

/**
 * A yes/no question; the answer is `{ p, confidence }` with `p` = P(yes). The literal
 * `name` becomes the answer's key in `decide`. Throws on an empty name or text, so a
 * malformed question fails when the policy is written, not when it is asked.
 */
export function noul<const N extends string>(
  name: N,
  text: string,
  criteria?: NoulCriteria,
): NoulQuestion<N> {
  checkHead(name, text);
  const base = { kind: "noul" as const, name, text };
  return Object.freeze(criteria === undefined ? base : { ...base, criteria: { ...criteria } });
}

/**
 * Pick one option; the answer is `{ choice, p, confidence, probabilities }` with `choice`
 * typed as the option names. `options` is a record of option → description (or null),
 * or a plain list of option names. Throws on an empty name, text or option set.
 */
export function choice<const N extends string, const C extends string>(
  name: N,
  text: string,
  options: Readonly<Record<C, string | null>> | readonly C[],
): ChoiceQuestion<N, C> {
  checkHead(name, text);
  const record = Array.isArray(options)
    ? Object.fromEntries((options as readonly C[]).map((o) => [o, null]))
    : { ...options };
  if (Object.keys(record).length === 0) {
    throw new TypeError(`question ${name}: a choice needs at least one option`);
  }
  return Object.freeze({
    kind: "choice" as const,
    name,
    text,
    options: record as Readonly<Record<C, string | null>>,
  });
}

/**
 * Place the action on an ordered rubric, lowest (least severe) first; the answer is
 * `{ level, score, confidence, probabilities }` with `level` typed as the rubric labels.
 * Throws on an empty name or text, or a rubric of fewer than two levels.
 */
export function score<const N extends string, const L extends string>(
  name: N,
  text: string,
  rubric: readonly [L, L, ...L[]],
): ScoreQuestion<N, L> {
  checkHead(name, text);
  if (!Array.isArray(rubric) || rubric.length < 2) {
    throw new TypeError(`question ${name}: a rubric needs at least two levels`);
  }
  return Object.freeze({
    kind: "score" as const,
    name,
    text,
    rubric: [...rubric] as typeof rubric,
  });
}

/** The question builders as one namespace, as in the spec: `jev.noul`, `jev.choice`, `jev.score`. */
export const jev = Object.freeze({ noul, choice, score });
