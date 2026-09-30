import type { RiskBudget } from "../context/budget.ts";
import type { Features } from "../context/features.ts";
import type { JudgeErrorKind } from "../judge/types.ts";
import {
  type JevAnswer,
  VERDICT_SCHEMA,
  type Verdict,
  type VerdictResponse,
} from "../schema/verdict.ts";
import { clamp01 } from "./floor.ts";

/** What happened to one policy for one event; `doctor` and `explain` read these. */
export interface PolicyTrace {
  /** `name@version`. */
  readonly policy: string;
  readonly matched: boolean;
  /** Its questions were in the batch sent to the judge. */
  readonly asked: boolean;
  /** `decide` ran on routed answers (or on none, for a policy without `ask`). */
  readonly answered: boolean;
  /** Its contribution before precedents; null when it did not match. */
  readonly verdict: Verdict | null;
  /** A 0.5–0.8 confidence answer lowered its verdict to `hold`. */
  readonly capped: boolean;
  /** `fallback` (or the floor band) replaced `decide`. */
  readonly fallbackUsed: boolean;
  /** A precedent waived its (non-deny) verdict. */
  readonly waived: boolean;
  readonly whenMs: number;
  readonly whenOverBudget: boolean;
  readonly degraded: boolean;
  /** Why it fell back, or what failed; null when nothing did. */
  readonly note: string | null;
}

/** How the judge call went for this event. */
export type JudgeStatus = "not-asked" | "ok" | "cached" | JudgeErrorKind;

/** Engine-level facts about the decision, recorded for audit and tests. */
export interface DecisionFlags {
  /** Floor in the uncertain band `[0.3, 0.8]` (both ends inclusive). */
  readonly inBand: boolean;
  readonly questions: number;
  readonly judge: JudgeStatus;
  readonly scope: "not-asked" | "no-answer" | "discarded" | "used" | "capped";
  readonly precedent: "none" | "applied" | "ignored-kill";
  /** Budget at or over 80 %: the verdict was raised one step. */
  readonly budgetRaised: boolean;
  /** Budget at 100 % on a non-trivial action: the verdict is at least `hold`. */
  readonly budgetHeld: boolean;
  /** The verdict was `rewrite` with no single payload, so it was raised to `hold`. */
  readonly rewriteWithoutInput: boolean;
}

/** The engine's full decision for one pre event; the verdict response is a projection. */
export interface Decision {
  readonly verdict: Verdict;
  readonly risk: number;
  readonly floor: number;
  /** One sentence, safe to show the agent. */
  readonly reason: string;
  /** For the human only; stripped before anything reaches a harness. */
  readonly detail: string;
  /** Set exactly when `verdict` is `rewrite`. */
  readonly updated_input: Record<string, unknown> | null;
  readonly context_note: string | null;
  /** `name@version` of every matched policy. */
  readonly policies: readonly string[];
  readonly features: Readonly<Features>;
  readonly jev: readonly JevAnswer[];
  /** Budget after this event's charge. */
  readonly budget: { readonly spent: number; readonly limit: number };
  readonly trace: readonly PolicyTrace[];
  readonly flags: DecisionFlags;
  /** The session budget to store: this event's charge plus any hold surcharge (T7). */
  readonly nextBudget: RiskBudget;
}

/**
 * The `jev-cops.verdict/1` response for `decision`. It always passes `parseVerdict`:
 * risk and jev numbers are clamped to [0, 1] and `updated_input` is non-null exactly on
 * `rewrite` (combine guarantees a rewrite carries a payload). `detail` is included; the
 * daemon strips it before the response reaches a harness.
 */
export function toVerdictResponse(decision: Decision, eventId: string): VerdictResponse {
  const rewrite = decision.verdict === "rewrite" ? decision.updated_input : null;
  return {
    schema: VERDICT_SCHEMA,
    event_id: eventId,
    verdict: decision.verdict,
    risk: clamp01(decision.risk),
    reason: decision.reason,
    detail: decision.detail,
    updated_input: rewrite === null ? null : structuredClone(rewrite),
    context_note: decision.context_note,
    policies: [...decision.policies],
    features: { ...decision.features },
    jev: decision.jev.map((j) => ({
      ...j,
      p: clamp01(j.p, 0),
      confidence: clamp01(j.confidence, 0),
    })),
    budget: { spent: decision.budget.spent, limit: decision.budget.limit },
  };
}
