import { eventIdSchema, sessionIdSchema } from "@jevdict/core";
import { z } from "zod";
import { readAudit } from "./audit.ts";
import { DAEMON_VERSION, type Runtime } from "./daemon.ts";
import type { Reply } from "./service.ts";

/**
 * The human side of the daemon: resolving holds, explaining decisions, the risk budget
 * and health. Requests here carry ids and a decision only; nothing in them can shape a
 * precedent's scope (T7/T8).
 */

const resolveSchema = z.strictObject({
  event_id: eventIdSchema,
  decision: z.enum(["allow", "deny"]),
  by: z.string().trim().min(1).max(200),
});

const budgetResetSchema = z.strictObject({ session_id: sessionIdSchema });

function badRequest(error: z.ZodError): Reply {
  const issues = error.issues.map((i) => ({ path: i.path.join("."), message: i.message }));
  return { status: 400, body: { error: "invalid request", issues } };
}

/**
 * `POST /v1/resolve`: a human resolved a held event. `allow` grants a precedent with the
 * scope the daemon proposed when it held the event; `deny` just closes the hold. Both are
 * audited. 404 when the event was not held (or was already resolved).
 */
export function handleResolve(rt: Runtime, body: unknown): Reply {
  const parsed = resolveSchema.safeParse(body);
  if (!parsed.success) return badRequest(parsed.error);
  const { event_id, decision, by } = parsed.data;
  const held = rt.precedents.pendingHold(event_id);
  if (held === null) return { status: 404, body: { error: "no pending hold for this event" } };
  const precedent = decision === "allow" ? rt.precedents.grant(event_id, by) : null;
  if (decision === "deny") rt.precedents.dropHold(event_id);
  rt.audit.append({
    kind: "precedent",
    event_id,
    session_id: held.sessionId,
    payload: { action: decision === "allow" ? "grant" : "resolve-deny", by, precedent },
  });
  return { status: 200, body: { ok: true, precedent } };
}

/**
 * `GET /v1/explain/:event_id`: the full `judge` audit line (with the human `detail`) and
 * every other line naming the event. Only served on the socket and loopback HTTP.
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

/** `POST /v1/budget/reset`: a human resets a session's budget; audited. */
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

/** `GET /v1/health`: version, policies with degraded flags, judge, enforcement, uptime. */
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
      uptime: Math.max(0, Math.round((rt.now() - rt.startedAt) / 1000)),
    },
  };
}
