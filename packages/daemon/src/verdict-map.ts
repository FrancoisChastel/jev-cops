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

/** The harness-facing response and the mappings applied to get it. */
export interface HarnessVerdict {
  readonly response: VerdictResponse;
  readonly mapping: readonly string[];
}

function withoutDetail(r: VerdictResponse): VerdictResponse {
  const { detail: _human, ...rest } = r;
  return rest;
}

/**
 * The `jevdict.verdict/1` response the harness receives for `decision`:
 * 1. `detail` is stripped (spec: never returned to the harness; `explain` shows it).
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
  let response = withoutDetail(toVerdictResponse(decision, eventId));
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
