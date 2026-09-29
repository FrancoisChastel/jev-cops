import {
  type Decision,
  type SessionMode,
  toVerdictResponse,
  type VerdictResponse,
  verdictRank,
} from "@jevdict/core";
import type { EnforcementMode } from "./config.ts";

/** Trace names of the daemon's own mappings, recorded on the audit line. */
export const HEADLESS_HOLD_DENIED = "headlessHoldDenied";
export const OBSERVE_ONLY = "observe";
/** Resolution of the risk a harness sees; the audit line keeps the exact value. */
export const HARNESS_RISK_STEP = 0.1;

/** The harness-facing response and the mappings applied to get it. */
export interface HarnessVerdict {
  readonly response: VerdictResponse;
  readonly mapping: readonly string[];
}

/** `risk` to {@link HARNESS_RISK_STEP}, clamped to [0, 1]. */
function coarseRisk(risk: number): number {
  const steps = Math.round(1 / HARNESS_RISK_STEP);
  return Math.min(1, Math.max(0, Math.round(risk * steps) / steps));
}

/**
 * What a harness may see: no `detail` (human only), no `features` and no `jev` answers,
 * and `risk` to one decimal. Features and exact scores are an oracle for tuning text aimed
 * at the judge (T6) to anyone who can call `/v1/judge`; adapters use none of them.
 */
function forHarness(r: VerdictResponse): VerdictResponse {
  const { detail: _human, ...rest } = r;
  return { ...rest, risk: coarseRisk(r.risk), features: {}, jev: [] };
}

/**
 * The `jevdict.verdict/1` response the harness receives for `decision`:
 * 1. `detail` is stripped (spec: never returned to the harness; `explain` shows it), and
 *    so are the scores: `features: {}`, `jev: []`, `risk` to one decimal (T6).
 * 2. D-008: a `hold` in a headless session becomes `deny` with the same reason.
 * 3. `observe` enforcement: the verdict becomes `allow` with no rewrite; for a verdict
 *    of `hold` or above the context note says what jevdict would have done.
 * Rewrites never survive a mapping, so `updated_input` stays null unless `rewrite`.
 */
export function harnessVerdict(
  decision: Decision,
  eventId: string,
  enforcement: EnforcementMode,
  sessionMode: SessionMode | undefined,
): HarnessVerdict {
  let response = forHarness(toVerdictResponse(decision, eventId));
  const mapping: string[] = [];
  if (sessionMode === "headless" && response.verdict === "hold") {
    response = { ...response, verdict: "deny", updated_input: null };
    mapping.push(HEADLESS_HOLD_DENIED);
  }
  if (enforcement === "observe" && response.verdict !== "allow") {
    const note =
      verdictRank(response.verdict) >= verdictRank("hold")
        ? `jevdict would have: ${response.verdict} — ${response.reason}`
        : null;
    response = { ...response, verdict: "allow", updated_input: null, context_note: note };
    mapping.push(OBSERVE_ONLY);
  }
  return { response, mapping };
}
