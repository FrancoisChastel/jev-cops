import type { Answer, JudgeResult } from "../judge/types.ts";
import {
  compareVerdict,
  isDenyClass,
  maxVerdict,
  VERDICTS,
  type Verdict,
} from "../schema/verdict.ts";
import type { PolicyConfig } from "./config.ts";
import type { PolicyTrace } from "./decision.ts";
import type { PolicyMatch } from "./evaluate.ts";
import type { QuestionPlan } from "./questions.ts";
import { type Routed, routePolicyAnswers } from "./routing.ts";
import type { PolicyContext, PolicyDefinition, PolicyEvent, PrecedentMatch } from "./types.ts";

/** One policy's say in the decision; `verdict` null means it contributes nothing. */
export interface Contribution {
  readonly match: PolicyMatch;
  readonly verdict: Verdict | null;
  /** The answers `decide` saw; `{}` when it fell back or asked nothing. */
  readonly answers: Readonly<Record<string, Answer>>;
  readonly trace: PolicyTrace;
}

/** Everything a contribution depends on besides the policy's own match. */
export interface ContributeEnv {
  e: PolicyEvent;
  ctx: PolicyContext;
  plan: QuestionPlan;
  judged: JudgeResult | null;
  /** `bandVerdict(floor)`: the default fallback, "the floor stands". */
  bandFloor: Verdict;
  config: PolicyConfig;
}

/** The less severe of two verdicts. */
export function minVerdict(a: Verdict, b: Verdict): Verdict {
  return compareVerdict(a, b) <= 0 ? a : b;
}

/** `v` clamped into a declared `[low, high]` range; unchanged without one. */
export function clampRange(v: Verdict, range: readonly [Verdict, Verdict] | undefined): Verdict {
  return range === undefined ? v : maxVerdict(range[0], minVerdict(v, range[1]));
}

function isVerdict(value: unknown): value is Verdict {
  return typeof value === "string" && (VERDICTS as readonly string[]).includes(value);
}

/** Calls `decide`; a throw or a non-verdict comes back as an error string. */
function runDecide(
  p: PolicyDefinition,
  e: PolicyEvent,
  ctx: PolicyContext,
  answers: Readonly<Record<string, Answer>>,
): Verdict | { error: string } {
  try {
    const v: unknown = p.decide(e, ctx, answers);
    return isVerdict(v) ? v : { error: `decide returned ${String(v)}, not a verdict` };
  } catch (cause) {
    return { error: `decide threw: ${cause instanceof Error ? cause.message : String(cause)}` };
  }
}

function routeFor(m: PolicyMatch, env: ContributeEnv): Routed {
  if (m.policy.ask === undefined) return { kind: "answered", answers: {}, capped: false };
  const questions = env.plan.asked.get(m.key);
  if (questions === undefined) {
    return { kind: "fallback", why: env.plan.skipped.get(m.key) ?? "not asked" };
  }
  return routePolicyAnswers(m.policy.name, questions, env.judged, env.config);
}

function notes(...parts: Array<string | null>): string | null {
  const present = parts.filter((p): p is string => p !== null);
  return present.length === 0 ? null : present.join("; ");
}

function baseTrace(m: PolicyMatch): PolicyTrace {
  return {
    policy: m.key,
    matched: m.matched,
    asked: false,
    answered: false,
    verdict: null,
    capped: false,
    fallbackUsed: false,
    waived: false,
    whenMs: m.whenMs,
    whenOverBudget: m.whenOverBudget,
    degraded: m.degraded,
    note: m.error,
  };
}

/**
 * One policy's contribution (spec rules 1, 3, 4). Unmatched → nothing. Unasked,
 * unanswered or discarded questions → `fallback ?? bandVerdict(floor)`. Otherwise
 * `decide` runs, is clamped into `range`, then capped at `hold` when any answer had
 * confidence in [0.5, 0.8]. A `decide` that throws or returns a non-verdict fails toward
 * asking: at least `hold`, not clamped down by `range`.
 */
export function contribute(m: PolicyMatch, env: ContributeEnv): Contribution {
  const trace = baseTrace(m);
  if (!m.matched) return { match: m, verdict: null, answers: {}, trace };
  const asked = env.plan.asked.has(m.key);
  const fallback = m.policy.fallback ?? env.bandFloor;
  const routed = routeFor(m, env);
  if (routed.kind === "fallback") {
    const verdict = clampRange(fallback, m.policy.range);
    const t = { ...trace, asked, verdict, fallbackUsed: true, note: notes(m.error, routed.why) };
    return { match: m, verdict, answers: {}, trace: t };
  }
  const decided = runDecide(m.policy, env.e, env.ctx, routed.answers);
  if (typeof decided === "object") {
    const verdict = maxVerdict(fallback, "hold");
    const t = { ...trace, asked, verdict, note: notes(m.error, decided.error) };
    return { match: m, verdict, answers: routed.answers, trace: t };
  }
  const ranged = clampRange(decided, m.policy.range);
  const verdict = routed.capped ? minVerdict(ranged, env.config.confidence.cap) : ranged;
  const t = { ...trace, asked, answered: true, verdict, capped: verdict !== ranged };
  return { match: m, verdict, answers: routed.answers, trace: t };
}

/** Risk and contributions after a precedent, and whether it applied. */
export interface PrecedentOutcome {
  risk: number;
  contributions: Contribution[];
  status: "none" | "applied" | "ignored-kill";
}

/**
 * Applies a human-granted precedent (spec §Precedents): risk drops by at most
 * `maxRiskDelta` (0.3), and the non-deny verdicts of the policies it names are waived.
 * Deny-class verdicts are never waived, and if any policy returned `kill` the precedent
 * is ignored entirely ("never bypasses kill policies").
 */
export function applyPrecedent(
  risk: number,
  contributions: ReadonlyArray<Contribution>,
  precedent: PrecedentMatch | null,
  cfg: PolicyConfig,
): PrecedentOutcome {
  if (precedent === null) return { risk, contributions: [...contributions], status: "none" };
  if (contributions.some((c) => c.verdict === "kill")) {
    return { risk, contributions: [...contributions], status: "ignored-kill" };
  }
  const raw = Number.isNaN(precedent.riskDelta) ? 0 : precedent.riskDelta;
  const delta = Math.min(cfg.precedent.maxRiskDelta, Math.max(0, raw));
  const waived = contributions.map((c) => {
    const named = precedent.policies.includes(c.match.policy.name);
    if (!named || c.verdict === null || isDenyClass(c.verdict)) return c;
    return { ...c, verdict: null, trace: { ...c.trace, waived: true } };
  });
  return { risk: Math.max(0, risk - delta), contributions: waived, status: "applied" };
}
