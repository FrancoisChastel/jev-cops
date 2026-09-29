import type { Features } from "../context/features.ts";
import type { Verdict } from "../schema/verdict.ts";
import { DEFAULT_POLICY_CONFIG, type PolicyConfig } from "./config.ts";

/** The deterministic floor risk and one human-readable line per non-zero term. */
export interface FloorResult {
  risk: number;
  why: string[];
}

/** Clamps to [0, 1]; NaN becomes `ifNaN`, chosen by the caller toward more risk. */
export function clamp01(value: number, ifNaN = 1): number {
  if (Number.isNaN(value)) return ifNaN;
  return Math.min(1, Math.max(0, value));
}

/** Rounds to `decimals` so a sum that is a band boundary is not lost to float drift. */
export function roundRisk(value: number, cfg: PolicyConfig = DEFAULT_POLICY_CONFIG): number {
  const scale = 10 ** cfg.floor.decimals;
  return clamp01(Math.round(value * scale) / scale);
}

/**
 * Deterministic floor (PLAN-M0 proposal, recorded as a decision):
 * `clamp01(0.35·taint + 0.25·(1−scope) + 0.20·sequence + 0.10·environment + 0.10·reversibility)`.
 * Every feature is clamped first and NaN counts as the risky end (scope NaN → 0), so a
 * broken feature can only raise the floor. Pure; nothing a model says reaches it.
 */
export function floorRisk(
  features: Readonly<Features>,
  cfg: PolicyConfig = DEFAULT_POLICY_CONFIG,
): FloorResult {
  const w = cfg.floor.weights;
  const terms: Array<[string, number, number]> = [
    ["taint", clamp01(features.taint), w.taint],
    ["scope gap", 1 - clamp01(features.scope, 0), w.scopeGap],
    ["sequence", clamp01(features.sequence), w.sequence],
    ["environment", clamp01(features.environment), w.environment],
    ["reversibility", clamp01(features.reversibility), w.reversibility],
  ];
  const risk = roundRisk(
    terms.reduce((sum, [, value, weight]) => sum + value * weight, 0),
    cfg,
  );
  const why = terms
    .filter(([, value, weight]) => value * weight > 0)
    .map(([name, value, weight]) => `${name} ${value.toFixed(2)} × ${weight.toFixed(2)}`);
  return { risk, why: [...why, `floor ${risk.toFixed(2)}`] };
}

/**
 * The spec's band verdict for a risk: `< 0.3` allow, `[0.3, 0.5)` annotate, `[0.5, 0.8]`
 * hold, `> 0.8` deny. Boundaries: 0.3 → annotate, 0.5 → hold, 0.8 → hold. NaN → deny.
 * Bands never produce `rewrite` (needs a payload) or `kill` (policy-only).
 */
export function bandVerdict(risk: number, cfg: PolicyConfig = DEFAULT_POLICY_CONFIG): Verdict {
  if (Number.isNaN(risk) || risk > cfg.bands.deny) return "deny";
  if (risk >= cfg.bands.hold) return "hold";
  if (risk >= cfg.bands.annotate) return "annotate";
  return "allow";
}
