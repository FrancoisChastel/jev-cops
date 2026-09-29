import type { BudgetConfig } from "./config.ts";

const MINUTE_MS = 60_000;

/**
 * A session's risk budget (spec §Risk budget). Immutable: every operation returns a new
 * budget. `holds` counts holds per precedent key so repeats cost more (T7).
 */
export interface RiskBudget {
  readonly spent: number;
  readonly limit: number;
  /** Time of the last charge; null before the first event. */
  readonly lastActivityAt: number | null;
  readonly holds: Readonly<Record<string, number>>;
}

/** Threshold flags: at `raiseAt` raise every verdict one step, at `holdAt` hold everything. */
export interface BudgetStatus {
  raiseSteps: 0 | 1;
  holdAll: boolean;
}

/** Result of a charge: the new budget, what it cost, and the thresholds after it. */
export interface BudgetCharge extends BudgetStatus {
  budget: RiskBudget;
  cost: number;
}

/** A fresh, unspent budget with the configured limit. */
export function createBudget(cfg: BudgetConfig): RiskBudget {
  return { spent: 0, limit: cfg.limit, lastActivityAt: null, holds: {} };
}

function clampRisk(risk: number): number {
  if (Number.isNaN(risk)) return 1;
  return Math.min(1, Math.max(0, risk));
}

/** `round(risk * costScale)`; NaN or out-of-range risk is clamped, NaN to the maximum. */
export function eventCost(risk: number, cfg: BudgetConfig): number {
  return Math.round(clampRisk(risk) * cfg.costScale);
}

/**
 * Returns `decayPerMinute` points per *whole* minute since the last activity, floored at
 * zero spent. Partial minutes never decay, so a steady trickle of small steps adds up.
 */
function decayed(budget: RiskBudget, now: number, cfg: BudgetConfig): RiskBudget {
  if (budget.lastActivityAt === null) return budget;
  const idle = Math.max(0, now - budget.lastActivityAt);
  const decay = cfg.decayPerMinute * Math.floor(idle / MINUTE_MS);
  return { ...budget, spent: Math.max(0, budget.spent - decay) };
}

/** Threshold flags for `budget` as it stands; a zero limit holds everything. */
export function budgetStatus(budget: RiskBudget, cfg: BudgetConfig): BudgetStatus {
  const ratio = budget.limit <= 0 ? Number.POSITIVE_INFINITY : budget.spent / budget.limit;
  return { raiseSteps: ratio >= cfg.raiseAt ? 1 : 0, holdAll: ratio >= cfg.holdAt };
}

function spend(budget: RiskBudget, cost: number, now: number, cfg: BudgetConfig): BudgetCharge {
  const next = { ...budget, spent: budget.spent + cost, lastActivityAt: now };
  return { budget: next, cost, ...budgetStatus(next, cfg) };
}

/** Applies inactivity decay, then charges `round(risk * 20)`; returns the new budget and flags. */
export function charge(
  budget: RiskBudget,
  risk: number,
  now: number,
  cfg: BudgetConfig,
): BudgetCharge {
  return spend(decayed(budget, now, cfg), eventCost(risk, cfg), now, cfg);
}

/**
 * Surcharge for an event held under precedent `key`, on top of {@link charge}: with
 * `n` earlier holds of the same key the event costs `base * factor^n` in total, so
 * farming holds with near-identical arguments doubles in price each time (T7).
 * The surcharge is capped at the limit.
 */
export function chargeHold(
  budget: RiskBudget,
  key: string,
  risk: number,
  now: number,
  cfg: BudgetConfig,
): BudgetCharge {
  const repeats = Object.hasOwn(budget.holds, key) ? (budget.holds[key] ?? 0) : 0;
  const base = eventCost(risk, cfg);
  const surcharge = Math.min(budget.limit, base * (cfg.holdRepeatFactor ** repeats - 1));
  const withHold = { ...decayed(budget, now, cfg), holds: { ...budget.holds, [key]: repeats + 1 } };
  return spend(withHold, surcharge, now, cfg);
}

/** A human reset: nothing spent, same limit, hold counts kept for the session (T7). */
export function resetBudget(budget: RiskBudget, now: number): RiskBudget {
  return { ...budget, spent: 0, lastActivityAt: now };
}
