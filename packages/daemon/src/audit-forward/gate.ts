import type { AuditLog } from "../audit.ts";
import type { AuditForward } from "../config-audit.ts";
import type { AuditForwarder, ForwarderStatus } from "./types.ts";

/**
 * `[audit.forward] required = true` (D-103, fail closed by opt-in). Once the forwarder is
 * more than `max_lag_lines` lines or `max_lag_ms` behind, every line judged from then on
 * could be cut from the local log with no off-box copy, so `/v1/judge` refuses the deny
 * class (503, which every adapter blocks: T2) and keeps judging the observe class (reads,
 * which the adapters would otherwise let through unjudged). Each refusal is audited.
 */

/** Why forwarding is too far behind to judge the deny class, or null. */
export function forwardingBehind(
  fwd: AuditForward | null,
  status: ForwarderStatus | null,
): string | null {
  if (fwd === null || !fwd.required || status === null) return null;
  if (status.lagLines > fwd.maxLagLines) {
    return `the audit forwarder is ${status.lagLines} lines behind (max_lag_lines ${fwd.maxLagLines})`;
  }
  if (status.lagMs > fwd.maxLagMs) {
    return `the audit forwarder has been behind for ${status.lagMs} ms (max_lag_ms ${fwd.maxLagMs})`;
  }
  return null;
}

/** A read (`fs.read`): the observe class, judged whatever the forwarder's state. */
function isObserveClass(body: unknown): boolean {
  const call = typeof body === "object" && body !== null ? Reflect.get(body, "call") : null;
  return typeof call === "object" && call !== null && Reflect.get(call, "kind") === "fs.read";
}

function eventId(body: unknown): { event_id?: string } {
  const id = typeof body === "object" && body !== null ? Reflect.get(body, "id") : undefined;
  return typeof id === "string" ? { event_id: id } : {};
}

/** The parts of the runtime the gate reads. */
export interface GateParts {
  readonly audit: AuditLog;
  readonly forwarder: AuditForwarder | null;
  readonly config: { readonly audit: { readonly forward: AuditForward | null } };
}

/**
 * The 503 for a deny-class judge request while required forwarding is behind, or null to
 * judge it. The refusal is an `anomaly` line (it will be shipped when the receiver returns).
 */
export function refuseUnshipped(rt: GateParts, body: unknown) {
  const why = forwardingBehind(rt.config.audit.forward, rt.forwarder?.status() ?? null);
  if (why === null || isObserveClass(body)) return null;
  rt.audit.append({
    kind: "anomaly",
    ...eventId(body),
    payload: { reason: "audit forwarding required: deny-class call refused", why },
  });
  return { status: 503, body: { error: "audit forwarder down", reason: why } };
}
