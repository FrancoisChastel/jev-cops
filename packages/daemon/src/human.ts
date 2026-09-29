import { eventIdSchema, sessionIdSchema } from "@jevdict/core";
import { z } from "zod";
import { readAudit } from "./audit.ts";
import { DAEMON_VERSION, type Runtime } from "./daemon.ts";
import type { Reply } from "./service.ts";

/**
 * The human side of the daemon: resolving holds, explaining decisions, the risk budget
 * and health. Requests here carry ids and a decision only; nothing in them can shape a
 * precedent's scope (T7/T8). Which socket serves which route is in `routes.ts`.
 */

const resolveSchema = z.strictObject({
  event_id: eventIdSchema,
  decision: z.enum(["allow", "deny"]),
  by: z.string().trim().min(1).max(200),
  /** Checked against the stored hash; missing is refused with 403 like a wrong one. */
  hold_token: z.string().max(256).optional(),
});

const budgetResetSchema = z.strictObject({ session_id: sessionIdSchema });

function badRequest(error: z.ZodError): Reply {
  const issues = error.issues.map((i) => ({ path: i.path.join("."), message: i.message }));
  return { status: 400, body: { error: "invalid request", issues } };
}

/**
 * `POST /v1/resolve`: a human resolved a held event. The request must carry the event's
 * `hold_token`, which only the adapter that received the hold has: a missing, wrong,
 * reused or expired token (or an event that was never held) is 403 plus an `anomaly`
 * line, and nothing is granted (T7/T8). With a valid token, `allow` grants a precedent
 * with the scope the daemon proposed when it held the event; `deny` just closes the
 * hold. Both are audited.
 */
export function handleResolve(rt: Runtime, body: unknown): Reply {
  const parsed = resolveSchema.safeParse(body);
  if (!parsed.success) return badRequest(parsed.error);
  const { event_id, decision, by, hold_token } = parsed.data;
  const redeemed = rt.precedents.redeem(event_id, hold_token);
  if (!redeemed.ok) {
    rt.audit.append({
      kind: "anomaly",
      event_id,
      payload: { reason: "resolve-without-valid-token", why: redeemed.why, decision, by },
    });
    return { status: 403, body: { error: "invalid hold token" } };
  }
  const held = redeemed.hold;
  const precedent = decision === "allow" ? rt.precedents.grant(event_id, by) : null;
  if (decision === "deny") rt.precedents.dropHold(event_id);
  rt.confirmViews.delete(event_id);
  rt.audit.append({
    kind: "precedent",
    event_id,
    session_id: held.sessionId,
    payload: { action: decision === "allow" ? "grant" : "resolve-deny", by, precedent },
  });
  return { status: 200, body: { ok: true, precedent } };
}

/**
 * `GET /v1/explain/:event_id` on the admin socket: the full `judge` audit line (with the
 * human `detail`, trace and features' evidence) and every other line naming the event.
 * Agent channels serve only the confirm view (`confirm-view.ts`).
 */
export function handleExplain(rt: Runtime, eventId: string): Reply {
  const { lines } = readAudit(rt.config.audit.path);
  const related = lines.filter((l) => l.event_id === eventId);
  const judge = related.findLast((l) => l.kind === "judge");
  if (judge === undefined) return { status: 404, body: { error: "no judged event with this id" } };
  return { status: 200, body: { line: judge, related: related.filter((l) => l !== judge) } };
}

/** `GET /v1/budget/:session_id`: the stored budget of a known session. */
export function handleBudget(rt: Runtime, sessionId: string): Reply {
  const budget = rt.sessions.budget(sessionId);
  if (budget === null) return { status: 404, body: { error: "unknown session" } };
  return { status: 200, body: { session_id: sessionId, spent: budget.spent, limit: budget.limit } };
}

/**
 * `POST /v1/budget/reset`: a human resets a session's budget; audited. Served on the
 * admin socket only (H1): the agent-facing socket answers 404, so an agent cannot undo
 * "hold until a human resets the budget" by talking to the socket itself.
 */
export function handleBudgetReset(rt: Runtime, body: unknown): Reply {
  const parsed = budgetResetSchema.safeParse(body);
  if (!parsed.success) return badRequest(parsed.error);
  const sessionId = parsed.data.session_id;
  const budget = rt.sessions.resetBudget(sessionId);
  if (budget === null) return { status: 404, body: { error: "unknown session" } };
  rt.audit.append({
    kind: "precedent",
    session_id: sessionId,
    payload: { action: "budget-reset" },
  });
  return { status: 200, body: { session_id: sessionId, spent: budget.spent, limit: budget.limit } };
}

/**
 * `GET /v1/health`: version, policies with degraded flags, judge, enforcement, both
 * sockets, how many root sessions are latched killed, uptime.
 */
export function handleHealth(rt: Runtime): Reply {
  const policies = rt.policies.current().policies.map((p) => ({
    name: p.name,
    version: p.version,
    degraded: rt.degraded.get(`${p.name}@${p.version}`),
  }));
  return {
    status: 200,
    body: {
      ok: true,
      version: DAEMON_VERSION,
      policies,
      judge: rt.judgeName,
      enforcement: rt.config.enforcement.mode,
      sockets: { agent: rt.config.daemon.socket, admin: rt.config.daemon.adminSocket },
      latched_sessions: rt.latch.count(),
      uptime: Math.max(0, Math.round((rt.now() - rt.startedAt) / 1000)),
    },
  };
}
