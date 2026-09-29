import { createBudget } from "../../../packages/core/src/context/budget.ts";
import { DEFAULT_CONTEXT_CONFIG } from "../../../packages/core/src/context/config.ts";
import type { Features } from "../../../packages/core/src/context/features.ts";
import type { Answer, JudgeResult } from "../../../packages/core/src/judge/types.ts";
import { combine } from "../../../packages/core/src/policy/combine.ts";
import {
  DEFAULT_POLICY_CONFIG,
  type PolicyConfig,
} from "../../../packages/core/src/policy/config.ts";
import type { Decision } from "../../../packages/core/src/policy/decision.ts";
import { createWhenTracker, evaluatePolicies } from "../../../packages/core/src/policy/evaluate.ts";
import { floorRisk } from "../../../packages/core/src/policy/floor.ts";
import { planQuestions, type QuestionPlan } from "../../../packages/core/src/policy/questions.ts";
import type {
  PolicyContext,
  PolicyDefinition,
  PolicyEvent,
  PrecedentMatch,
} from "../../../packages/core/src/policy/types.ts";
import type { CallKind } from "../../../packages/core/src/schema/event.ts";
import type { Verdict } from "../../../packages/core/src/schema/verdict.ts";

/**
 * Test scaffolding for `combine`: features with an exact floor, small policies, and a
 * runner that plans questions and combines like the engine does, minus normalization.
 */

/** Features whose floor is exactly `x` (every term at `x`, scope at `1 − x`). */
export function featuresAt(x: number): Features {
  return { taint: x, scope: 1 - x, sequence: x, environment: x, reversibility: x };
}

/** A policy that always matches and returns `verdict`, optionally asking questions. */
export function fixed(
  name: string,
  verdict: Verdict,
  extra: Partial<PolicyDefinition> = {},
): PolicyDefinition {
  return {
    name,
    version: 1,
    owner: "test",
    when: () => true,
    decide: () => verdict,
    reason: `${name} says ${verdict}.`,
    ...extra,
  };
}

/** A policy asking one noul `safe`; decide: allow when p > 0.5, else `unsafe`. */
export function asking(name: string, unsafe: Verdict = "deny"): PolicyDefinition {
  return {
    name,
    version: 1,
    owner: "test",
    when: () => true,
    ask: () => [{ kind: "noul", name: "safe", text: "Is this action safe?" }],
    decide: (_e, _c, a) =>
      ((a.safe as { p: number } | undefined)?.p ?? 0) > 0.5 ? "allow" : unsafe,
    reason: `${name} decided.`,
  };
}

/** A successful judge result answering every name in `answers`. */
export function answered(answers: Record<string, Answer>, cached = false): JudgeResult {
  return { ok: true, answers, provider: "mock", model: "m", cached, latencyMs: 1 };
}

/** A noul answer with explicit confidence. */
export function noul(p: number, confidence: number): Answer {
  return { kind: "noul", p, confidence };
}

/** Scenario for {@link runCombine}; everything but `features` has a default. */
export interface Scenario {
  features: Features;
  policies?: PolicyDefinition[];
  /** Judge outcome given the plan; default: no judge call. */
  judge?: (plan: QuestionPlan) => JudgeResult | null;
  scopeUnsure?: boolean;
  task?: string | null;
  kind?: CallKind;
  input?: Record<string, unknown>;
  spent?: number;
  precedent?: PrecedentMatch | null;
  config?: PolicyConfig;
}

/** Plans and combines one event the way the engine does. */
export function runCombine(s: Scenario): { decision: Decision; plan: QuestionPlan } {
  const config = s.config ?? DEFAULT_POLICY_CONFIG;
  const e = {
    kind: s.kind ?? "exec",
    call: { input: s.input ?? { command: "rm -rf build" } },
  } as unknown as PolicyEvent;
  const ctx = {} as PolicyContext;
  const tracker = createWhenTracker(10);
  const matches = evaluatePolicies(s.policies ?? [], e, ctx, {
    tracker,
    sessionId: "s",
    config: { ...config, when: { ...config.when, budgetMs: 1_000 } },
  });
  const plan = planQuestions({
    matches,
    e,
    ctx,
    floor: combineFloor(s.features, config),
    scopeUnsure: s.scopeUnsure ?? false,
    task: s.task === undefined ? "Fix the flaky test in auth/" : s.task,
    config,
  });
  const judged = plan.batch.length === 0 ? null : (s.judge?.(plan) ?? null);
  const budget = { ...createBudget(DEFAULT_CONTEXT_CONFIG.budget), spent: s.spent ?? 0 };
  const decision = combine({
    event: e,
    ctx,
    features: s.features,
    why: { taint: [], scope: [], sequence: [], environment: [], reversibility: [] },
    matches,
    plan,
    judged,
    precedent: s.precedent ?? null,
    budget,
    holdKey: "exec:rm",
    now: 0,
    config,
    budgetConfig: DEFAULT_CONTEXT_CONFIG.budget,
  });
  return { decision, plan };
}

function combineFloor(features: Features, config: PolicyConfig): number {
  return floorRisk(features, config).risk;
}
