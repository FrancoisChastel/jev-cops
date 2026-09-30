import { type DeepPartial, deepFreeze, mergeConfig } from "../context/config.ts";
import { DEFAULT_JUDGE_CONFIG, type JudgeConfig } from "../judge/config.ts";
import type { CallKind } from "../schema/event.ts";
import type { Verdict } from "../schema/verdict.ts";

/** Floor weights (PLAN-M0 proposal): scope enters as its gap, `1 − scope`. */
export interface FloorWeights {
  taint: number;
  scopeGap: number;
  sequence: number;
  environment: number;
  reversibility: number;
}

/** Lower edges of the spec's risk bands: `>= annotate`, `>= hold`, `> deny`. */
export interface Bands {
  annotate: number;
  hold: number;
  deny: number;
}

/** Fixed, agent-safe sentences used when no policy supplies one. */
export interface PolicyTexts {
  /** Band reason per verdict, plus the budget hold and the rewrite-without-input cases. */
  reasons: Record<Verdict | "budget" | "missingRewrite", string>;
  /** Context note for an `annotate` that no policy explained. */
  annotateNote: string;
  /** Context note when the budget raised an `allow` to `annotate`. */
  budgetNote: string;
  maxReasonChars: number;
  maxNoteChars: number;
  maxDetailChars: number;
}

/**
 * Every threshold, weight and limit the policy engine uses (spec §Verdict ladder and
 * decision combination; D-009). One place to tune; merge a team override with
 * {@link resolvePolicyConfig}.
 */
export interface PolicyConfig {
  floor: {
    weights: FloorWeights;
    /** Risk is rounded to this many decimals so band boundaries survive float drift. */
    decimals: number;
  };
  bands: Bands;
  /** Questions are asked only when the floor is in `[min, max]`, both ends inclusive. */
  ask: {
    min: number;
    max: number;
    /** Ask the engine's own `serves_task` noul when deterministic scope is unsure. */
    scopeQuestion: boolean;
  };
  /** A judge answer lowers risk at most this far below the floor. */
  maxAnswerLowering: number;
  /** `< discardBelow` discarded; `[discardBelow, trustAbove]` capped at `cap`; above used as is. */
  confidence: { discardBelow: number; trustAbove: number; cap: Verdict };
  precedent: { maxRiskDelta: number };
  /** `when` budget per event; over it `degradeAfter` times in a session marks the policy degraded. */
  when: { budgetMs: number; degradeAfter: number; trackedSessions: number };
  /** Kinds the 100 % budget rule does not hold ("every non-trivial action"). */
  trivialKinds: CallKind[];
  /**
   * Extra paths policies must protect (`[policy] protectedPaths`: the hook and daemon
   * binaries, a relocated config dir). `~`/`$HOME` expand to the daemon's home; relative
   * entries are project-relative. Reach policies as `ctx.config.protectedPaths`.
   */
  protectedPaths: string[];
  texts: PolicyTexts;
  judge: JudgeConfig;
}

/** Spec defaults. Deeply frozen: derive variants with {@link resolvePolicyConfig}. */
export const DEFAULT_POLICY_CONFIG: Readonly<PolicyConfig> = deepFreeze({
  floor: {
    weights: { taint: 0.35, scopeGap: 0.25, sequence: 0.2, environment: 0.1, reversibility: 0.1 },
    decimals: 9,
  },
  bands: { annotate: 0.3, hold: 0.5, deny: 0.8 },
  ask: { min: 0.3, max: 0.8, scopeQuestion: true },
  maxAnswerLowering: 0.2,
  confidence: { discardBelow: 0.5, trustAbove: 0.8, cap: "hold" },
  precedent: { maxRiskDelta: 0.3 },
  when: { budgetMs: 2, degradeAfter: 3, trackedSessions: 1_000 },
  trivialKinds: ["fs.read"],
  protectedPaths: [],
  texts: {
    reasons: {
      allow: "No policy concern with this action.",
      annotate: "This action carries some risk in the current context.",
      rewrite: "This action was rewritten to a safer form.",
      hold: "This action is risky in the current context and needs a human decision.",
      deny: "This action is too risky in the current context.",
      kill: "This action is blocked and the session is stopped.",
      budget: "The session's risk budget is exhausted; a human must review further actions.",
      missingRewrite: "A safer form of this action could not be produced; a human must review it.",
    },
    annotateNote: "jev-cops flagged this action as moderately risky; stay within the task.",
    budgetNote: "Most of this session's risk budget is spent; further risky actions will be held.",
    maxReasonChars: 300,
    maxNoteChars: 1_000,
    maxDetailChars: 8_000,
  },
  judge: structuredClone(DEFAULT_JUDGE_CONFIG),
} satisfies PolicyConfig);

/** A partial policy config: objects merge, arrays and scalars replace. */
export type PolicyConfigInput = DeepPartial<PolicyConfig>;

/** The defaults deep-merged with `partial`, as a fresh object; the defaults are untouched. */
export function resolvePolicyConfig(partial: PolicyConfigInput = {}): PolicyConfig {
  return mergeConfig<PolicyConfig>(DEFAULT_POLICY_CONFIG, partial);
}
