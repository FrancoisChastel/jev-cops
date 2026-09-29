import { type BudgetCharge, charge, chargeHold, type RiskBudget } from "../context/budget.ts";
import type { BudgetConfig } from "../context/config.ts";
import type { FeatureExplanation, Features } from "../context/features.ts";
import type { JudgeResult } from "../judge/types.ts";
import { canonicalJson } from "../normalizer/hash.ts";
import {
  compareVerdict,
  isDenyClass,
  maxVerdict,
  raiseVerdict,
  type Verdict,
} from "../schema/verdict.ts";
import type { PolicyConfig } from "./config.ts";
import {
  applyPrecedent,
  type Contribution,
  contribute,
  minVerdict,
  type PrecedentOutcome,
} from "./contribute.ts";
import type { Decision, DecisionFlags, JudgeStatus } from "./decision.ts";
import type { PolicyMatch } from "./evaluate.ts";
import { contextNoteFor, detailFor, type ExplainInput, reasonFor } from "./explain.ts";
import { bandVerdict, type FloorResult, floorRisk, roundRisk } from "./floor.ts";
import type { QuestionPlan } from "./questions.ts";
import { jevEntries, routeScopeAnswer, type ScopeRouting } from "./routing.ts";
import type { PolicyContext, PolicyEvent, PrecedentMatch } from "./types.ts";

/** Everything one decision depends on; `combine` is a pure function of it. */
export interface CombineInput {
  readonly event: PolicyEvent;
  readonly ctx: PolicyContext;
  readonly features: Readonly<Features>;
  readonly why: Readonly<FeatureExplanation>;
  readonly matches: readonly PolicyMatch[];
  readonly plan: QuestionPlan;
  /** The judge's result for `plan.batch`; null when nothing was asked. */
  readonly judged: JudgeResult | null;
  readonly precedent: PrecedentMatch | null;
  /** The session budget before this event. */
  readonly budget: RiskBudget;
  /** Precedent key of this action, for the repeated-hold surcharge (T7). */
  readonly holdKey: string;
  readonly now: number;
  readonly config: PolicyConfig;
  readonly budgetConfig: BudgetConfig;
}

interface RiskStep {
  floor: FloorResult;
  risk: number;
  scope: ScopeRouting;
}

/**
 * Rule 2: `risk = max(floor − 0.2, riskAfterAnswers)`, where `riskAfterAnswers` is the
 * floor recomputed with the semantic scope when the engine's scope question was answered
 * with confidence >= 0.5. An answer can raise risk without limit, lower it by 0.2 at most.
 */
function riskAfterAnswers(input: CombineInput): RiskStep {
  const { config } = input;
  const floor = floorRisk(input.features, config);
  const scope = routeScopeAnswer(input.plan.scopeAsked, input.judged, config);
  const after =
    scope.value === null
      ? floor.risk
      : floorRisk({ ...input.features, scope: scope.value }, config).risk;
  const risk = roundRisk(Math.max(floor.risk - config.maxAnswerLowering, after), config);
  return { floor, risk, scope };
}

/** The band component; a 0.5–0.8 confidence scope answer cannot push it past `hold`. */
function bandComponent(step: RiskStep, config: PolicyConfig): Verdict {
  const band = bandVerdict(step.risk, config);
  if (step.scope.status !== "capped") return band;
  return maxVerdict(minVerdict(band, config.confidence.cap), bandVerdict(step.floor.risk, config));
}

interface BudgetStep {
  verdict: Verdict;
  charged: BudgetCharge;
  raised: boolean;
  held: boolean;
  heldByBudget: boolean;
}

/** Rule 5 budget: charge `round(risk·20)`, raise one step at 80 %, hold non-trivial at 100 %. */
function applyBudget(input: CombineInput, risk: number, base: Verdict): BudgetStep {
  const charged = charge(input.budget, risk, input.now, input.budgetConfig);
  const raised = charged.raiseSteps > 0;
  const stepped = raised ? raiseVerdict(base, charged.raiseSteps) : base;
  const held = charged.holdAll && !input.config.trivialKinds.includes(input.event.kind);
  const verdict = held ? maxVerdict(stepped, "hold") : stepped;
  return {
    verdict,
    charged,
    raised,
    held,
    heldByBudget: held && compareVerdict(stepped, "hold") < 0,
  };
}

/** The single payload of the rewriting policies; null when none or they disagree. */
function rewritePayload(
  input: CombineInput,
  contributions: ReadonlyArray<Contribution>,
): Record<string, unknown> | null {
  const payloads = contributions
    .filter((c) => c.verdict === "rewrite" && c.match.policy.rewrite !== undefined)
    .flatMap((c) => {
      try {
        const out: unknown = c.match.policy.rewrite?.(input.event, input.ctx, c.answers);
        return typeof out === "object" && out !== null && !Array.isArray(out) ? [out] : [];
      } catch {
        return [];
      }
    });
  const distinct = new Set(payloads.map((p) => canonicalJson(p)));
  return distinct.size === 1 && payloads[0] !== undefined
    ? structuredClone(payloads[0] as Record<string, unknown>)
    : null;
}

function judgeStatus(judged: JudgeResult | null): JudgeStatus {
  if (judged === null) return "not-asked";
  if (!judged.ok) return judged.error;
  return judged.cached ? "cached" : "ok";
}

/** The verdict and every intermediate the decision reports. */
interface Resolved {
  step: RiskStep;
  risk: number;
  contributions: Contribution[];
  precedent: PrecedentOutcome["status"];
  /** Verdict before the budget: max(band, policies), floor deny kept. */
  guarded: Verdict;
  budget: BudgetStep;
  payload: Record<string, unknown> | null;
  missing: boolean;
  verdict: Verdict;
  nextBudget: RiskBudget;
}

/** Rules 1–5 in order: risk, contributions, precedent, max, deny guard, budget, rewrite. */
function resolve(input: CombineInput): Resolved {
  const { config } = input;
  const step = riskAfterAnswers(input);
  const bandFloor = bandVerdict(step.floor.risk, config);
  const env = {
    e: input.event,
    ctx: input.ctx,
    plan: input.plan,
    judged: input.judged,
    bandFloor,
    config,
  };
  const contributed = input.matches.map((m) => contribute(m, env));
  const prec = applyPrecedent(step.risk, contributed, input.precedent, config);
  const risk = roundRisk(prec.risk, config);
  const fromPolicies = prec.contributions.reduce<Verdict>(
    (v, c) => (c.verdict === null ? v : maxVerdict(v, c.verdict)),
    bandComponent({ ...step, risk }, config),
  );
  const keepDeny = prec.status !== "applied" && isDenyClass(bandFloor);
  const guarded = keepDeny ? maxVerdict(fromPolicies, bandFloor) : fromPolicies;
  const budget = applyBudget(input, risk, guarded);
  const payload = budget.verdict === "rewrite" ? rewritePayload(input, prec.contributions) : null;
  const missing = budget.verdict === "rewrite" && payload === null;
  const verdict = missing ? "hold" : budget.verdict;
  const nextBudget =
    verdict === "hold"
      ? chargeHold(budget.charged.budget, input.holdKey, risk, input.now, input.budgetConfig).budget
      : budget.charged.budget;
  const { contributions, status } = prec;
  return {
    step,
    risk,
    contributions,
    precedent: status,
    guarded,
    budget,
    payload,
    missing,
    verdict,
    nextBudget,
  };
}

function flagsOf(input: CombineInput, r: Resolved): DecisionFlags {
  return {
    inBand: input.plan.inBand,
    questions: input.plan.batch.length,
    judge: judgeStatus(input.judged),
    scope: r.step.scope.status,
    precedent: r.precedent,
    budgetRaised: r.budget.raised,
    budgetHeld: r.budget.held,
    rewriteWithoutInput: r.missing,
  };
}

/**
 * Combines the floor, the policies and the judge's answers into one decision (spec
 * §Verdict ladder rules 1–5, budget, precedents). Pure apart from calling the policies'
 * own pure callbacks. Verdicts only move up: final = max(band(risk), every policy's
 * contribution), a floor band of `deny` is never lowered by an answer, then the budget
 * raises, and a `rewrite` without exactly one payload becomes `hold`.
 */
export function combine(input: CombineInput): Decision {
  const r = resolve(input);
  const flags = flagsOf(input, r);
  const explain: ExplainInput = {
    e: input.event,
    ctx: input.ctx,
    verdict: r.verdict,
    contributions: r.contributions,
    heldByBudget: r.budget.heldByBudget,
    annotatedByBudget: r.budget.raised && r.guarded === "allow",
    flags,
    config: input.config,
  };
  const budget = { spent: r.nextBudget.spent, limit: r.nextBudget.limit };
  const facts = {
    risk: r.risk,
    floorWhy: r.step.floor.why,
    features: input.features,
    why: input.why,
    budget,
  };
  return {
    verdict: r.verdict,
    risk: r.risk,
    floor: r.step.floor.risk,
    reason: reasonFor(explain),
    detail: detailFor(explain, facts),
    updated_input: r.verdict === "rewrite" ? r.payload : null,
    context_note: contextNoteFor(explain),
    policies: input.matches.filter((m) => m.matched).map((m) => m.key),
    features: { ...input.features },
    jev: jevEntries(input.plan.batch, input.judged),
    budget,
    trace: r.contributions.map((c) => c.trace),
    flags,
    nextBudget: r.nextBudget,
  };
}
