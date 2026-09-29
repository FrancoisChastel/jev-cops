import type { Features } from "../context/features.ts";
import type { OpaqueReason } from "../normalizer/types.ts";
import type { CallKind } from "../schema/event.ts";

/** A yes/no question; the answer is the probability of "yes". */
export interface NoulQuestion<N extends string = string> {
  readonly kind: "noul";
  readonly name: N;
  readonly text: string;
  readonly criteria?: { readonly yes?: string; readonly no?: string };
}

/** Pick one of `options`; each option may carry a description for the judge. */
export interface ChoiceQuestion<N extends string = string, C extends string = string> {
  readonly kind: "choice";
  readonly name: N;
  readonly text: string;
  readonly options: Readonly<Record<C, string | null>>;
}

/** Place the action on an ordered rubric, lowest first; at least two levels. */
export interface ScoreQuestion<N extends string = string, L extends string = string> {
  readonly kind: "score";
  readonly name: N;
  readonly text: string;
  readonly rubric: readonly [L, L, ...L[]];
}

/** One typed question for the semantic judge. Names are unique within a batch. */
export type Question = NoulQuestion | ChoiceQuestion | ScoreQuestion;

/** Answer to a {@link NoulQuestion}: `p` = P(yes). */
export interface NoulAnswer {
  readonly kind: "noul";
  readonly p: number;
  readonly confidence: number;
}

/** Answer to a {@link ChoiceQuestion}: the chosen option and its probability. */
export interface ChoiceAnswer<C extends string = string> {
  readonly kind: "choice";
  readonly choice: C;
  readonly p: number;
  readonly confidence: number;
  readonly probabilities: Readonly<Record<string, number>>;
}

/** Answer to a {@link ScoreQuestion}: `level` is the rubric label at `round(score)`. */
export interface ScoreAnswer<L extends string = string> {
  readonly kind: "score";
  readonly score: number;
  readonly level: L;
  readonly confidence: number;
  readonly probabilities: Readonly<Record<string, number>>;
}

/** Any typed answer; its `kind` matches the question it answers. */
export type Answer = NoulAnswer | ChoiceAnswer | ScoreAnswer;

/** The answer type for question `Q`, keeping its choice options and rubric labels. */
export type AnswerFor<Q extends Question> =
  Q extends ScoreQuestion<string, infer L>
    ? ScoreAnswer<L>
    : Q extends ChoiceQuestion<string, infer C>
      ? ChoiceAnswer<C>
      : NoulAnswer;

/** One earlier call as the judge sees it: its normalized shape, never agent prose. */
export interface JudgeCallSummary {
  readonly kind: CallKind;
  readonly command: string;
  readonly paths: readonly string[];
  readonly hosts: readonly string[];
  /** Null while the call has no result yet. */
  readonly ok: boolean | null;
}

/** Bounded case-file summary sent with every question batch. */
export interface JudgeCaseSummary {
  readonly recentCalls: readonly JudgeCallSummary[];
  readonly secretReads: number;
  readonly hostsSeen: readonly string[];
}

/**
 * Everything the semantic judge sees (spec: "the normalized event plus the case-file
 * summary, never the agent's own explanation text"). Built only by `buildJudgeState`,
 * which copies these fields and nothing else; `task` is the case file's immutable task.
 */
export interface JudgeState {
  readonly stateHash: string;
  readonly tool: string;
  readonly kind: CallKind;
  /** Normalized commands, one argv per line (tool plus targets for non-shell tools). */
  readonly command: string;
  /** The verbatim command, or the tool input minus agent-prose fields. */
  readonly raw: string;
  readonly verbs: readonly string[];
  readonly paths: readonly string[];
  readonly hosts: readonly string[];
  readonly opaque: readonly OpaqueReason[];
  readonly features: Readonly<Features>;
  readonly task: string | null;
  readonly casefile: JudgeCaseSummary;
}

/** Why a judge produced no usable answer; every one of them means "the floor stands". */
export type JudgeErrorKind = "timeout" | "unreachable" | "invalid" | "disabled";

/** Outcome of one batched request. Errors are values, never exceptions. */
export type JudgeResult =
  | {
      ok: true;
      answers: Record<string, Answer>;
      provider: string;
      model: string;
      cached: boolean;
      latencyMs: number;
    }
  | { ok: false; error: JudgeErrorKind; detail: string; latencyMs: number };

/** Per-call options: a tighter timeout and a signal the provider must honour. */
export interface JudgeAskOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
}

/**
 * A provider-agnostic semantic judge (D-004). `ask` answers every question in one
 * request and never rejects: failures come back as `{ ok: false }`.
 */
export interface Judge {
  readonly name: string;
  ask(
    state: JudgeState,
    questions: readonly Question[],
    opts?: JudgeAskOptions,
  ): Promise<JudgeResult>;
}

/**
 * Confidence of a noul answer for providers that report none (D-002): `abs(2p − 1)`,
 * 0 at p = 0.5 and 1 at the extremes. `p` is clamped to [0, 1]; NaN has no confidence.
 */
export function deriveNoulConfidence(p: number): number {
  if (Number.isNaN(p)) return 0;
  return Math.abs(2 * Math.min(1, Math.max(0, p)) - 1);
}

/**
 * The rubric label at `Math.round(score)`, clamped to the rubric. NaN fails toward the
 * top of the rubric, which by convention is the most severe level.
 */
export function scoreLevel<L extends string>(rubric: readonly [L, L, ...L[]], score: number): L {
  const top = rubric.length - 1;
  const index = Number.isNaN(score) ? top : Math.min(top, Math.max(0, Math.round(score)));
  return rubric[index] ?? rubric[0];
}
