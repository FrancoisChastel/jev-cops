import {
  type Budget,
  type Decision,
  toVerdictResponse,
  VERDICT_SCHEMA,
  type VerdictResponse,
  verdictRank,
} from "@jev-cops/core";
import type { EnforcementMode } from "./config.ts";
import type { NoHumanReason } from "./session-facts.ts";

/** Trace names of the daemon's own mappings, recorded on the audit line. */
export const HEADLESS_HOLD_DENIED = "headlessHoldDenied";
/** A `hold` in a harness permission mode that never prompts (`dontAsk`, `bypassPermissions`). */
export const PERMISSION_MODE_HOLD_DENIED = "permissionModeHoldDenied";
/** A call of a session latched killed: answered `kill` without running a policy. */
export const SESSION_KILLED = "sessionKilled";
export const OBSERVE_ONLY = "observe";
/** The agent-facing reason of every call of a latched session. */
export const SESSION_KILLED_REASON = "session terminated by jev-cops";
/** Resolution of the risk a harness sees; the audit line keeps the exact value. */
export const HARNESS_RISK_STEP = 0.1;

/** The harness-facing response and the mappings applied to get it. */
export interface HarnessVerdict {
  readonly response: VerdictResponse;
  readonly mapping: readonly string[];
}

const NO_HUMAN_MAPPING: Readonly<Record<NoHumanReason, string>> = {
  headless: HEADLESS_HOLD_DENIED,
  "permission-mode": PERMISSION_MODE_HOLD_DENIED,
};

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
 * The `jev-cops.verdict/1` response the harness receives for `decision`:
 * 1. `detail` is stripped (spec: never returned to the harness; `explain` shows it), and
 *    so are the scores: `features: {}`, `jev: []`, `risk` to one decimal (T6).
 * 2. D-008: a `hold` in a session where no human can answer becomes `deny` with the same
 *    reason: headless, or a permission mode that never prompts (`noHuman`, plan §5 rows
 *    10–11), traced as `headlessHoldDenied` / `permissionModeHoldDenied`.
 * 3. `observe` enforcement: the verdict becomes `allow` with no rewrite; for a verdict
 *    of `hold` or above the context note says what jev-cops would have done.
 * Rewrites never survive a mapping, so `updated_input` stays null unless `rewrite`.
 */
export function harnessVerdict(
  decision: Decision,
  eventId: string,
  enforcement: EnforcementMode,
  noHuman: NoHumanReason | null,
): HarnessVerdict {
  let response = forHarness(toVerdictResponse(decision, eventId));
  const mapping: string[] = [];
  if (noHuman !== null && response.verdict === "hold") {
    response = { ...response, verdict: "deny", updated_input: null };
    mapping.push(NO_HUMAN_MAPPING[noHuman]);
  }
  if (enforcement === "observe" && response.verdict !== "allow") {
    const note =
      verdictRank(response.verdict) >= verdictRank("hold")
        ? `jev-cops would have: ${response.verdict} — ${response.reason}`
        : null;
    response = { ...response, verdict: "allow", updated_input: null, context_note: note };
    mapping.push(OBSERVE_ONLY);
  }
  return { response, mapping };
}

/**
 * The response for any call of a session latched killed (D-072 proposal): `kill` with
 * {@link SESSION_KILLED_REASON}, no policies, the session's budget as it stands (nothing
 * is charged: nothing ran). Only served in `enforce` mode.
 */
export function latchedVerdict(eventId: string, budget: Budget): HarnessVerdict {
  const response: VerdictResponse = {
    schema: VERDICT_SCHEMA,
    event_id: eventId,
    verdict: "kill",
    risk: 1,
    reason: SESSION_KILLED_REASON,
    updated_input: null,
    context_note: null,
    policies: [],
    features: {},
    jev: [],
    budget: { spent: budget.spent, limit: budget.limit },
  };
  return { response, mapping: [SESSION_KILLED] };
}
