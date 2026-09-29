import type { Runtime } from "./daemon.ts";
import {
  handleBudget,
  handleBudgetReset,
  handleExplain,
  handleHealth,
  handleResolve,
} from "./human.ts";
import { handleJudge, handleObserve, type Reply } from "./service.ts";

/**
 * Which listener a request arrived on. `agent`: the Unix socket a sandbox mounts (and
 * loopback HTTP), which harness adapters use. `admin`: a second Unix socket that is never
 * mounted into a sandbox, for what only a human may do (H1: reset a risk budget).
 */
export type Surface = "agent" | "admin";

type Route = (rt: Runtime, body: unknown, param: string) => Reply | Promise<Reply>;

function message(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/** 500 plus an `anomaly` audit line; the adapter treats non-200 as unreachable (T2). */
async function safely(rt: Runtime, route: string, fn: () => Promise<Reply>): Promise<Reply> {
  try {
    return await fn();
  } catch (cause) {
    const error = message(cause);
    try {
      rt.audit.append({ kind: "anomaly", payload: { reason: "internal error", route, error } });
    } catch (auditCause) {
      rt.log.log("error", "audit append failed", { error: message(auditCause) });
    }
    rt.log.log("error", "internal error", { route, error });
    return { status: 500, body: { error: "internal error" } };
  }
}

/**
 * Past `judgeDeadlineMs` a judge request answers 504 `{ error: "judge timeout" }`, which
 * the adapter maps to `deny` (T3); an anomaly line records it. The late judgement still
 * finishes and writes its own line; its failure is swallowed.
 */
async function withDeadline(rt: Runtime, work: Promise<Reply>, body: unknown): Promise<Reply> {
  const ms = rt.config.daemon.judgeDeadlineMs;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), ms);
  });
  const outcome = await Promise.race([work, late]);
  clearTimeout(timer);
  if (outcome !== null) return outcome;
  work.catch(() => undefined);
  const id = (body as { id?: unknown } | null)?.id;
  rt.audit.append({
    kind: "anomaly",
    ...(typeof id === "string" ? { event_id: id } : {}),
    payload: { reason: "judge deadline exceeded", deadline_ms: ms },
  });
  return { status: 504, body: { error: "judge timeout" } };
}

async function readJson(req: Request): Promise<{ ok: true; body: unknown } | { ok: false }> {
  try {
    return { ok: true, body: await req.json() };
  } catch {
    return { ok: false };
  }
}

/** POST routes per surface. Budget reset is admin-only; everything a harness calls is agent-only. */
const POST_ROUTES: Readonly<Record<Surface, Readonly<Record<string, Route>>>> = {
  agent: {
    "/v1/judge": (rt, body) => withDeadline(rt, handleJudge(rt, body), body),
    "/v1/observe": (rt, body) => handleObserve(rt, body),
    "/v1/resolve": (rt, body) => handleResolve(rt, body),
  },
  admin: {
    "/v1/budget/reset": (rt, body) => handleBudgetReset(rt, body),
  },
};

/** GET routes: health and explain on both surfaces, the budget read on the agent's. */
function getRoute(path: string, surface: Surface): { route: Route; param: string } | null {
  if (path === "/v1/health") return { route: (rt) => handleHealth(rt), param: "" };
  const m = /^\/v1\/(explain|budget)\/([^/]+)$/.exec(path);
  if (m === null || (m[1] === "budget" && surface !== "agent")) return null;
  const param = decodeURIComponent(m[2] ?? "");
  const route: Route =
    m[1] === "explain" ? (rt, _b, p) => handleExplain(rt, p) : (rt, _b, p) => handleBudget(rt, p);
  return { route, param };
}

const NOT_FOUND: Reply = { status: 404, body: { error: "not found" } };

/** Routes one request for `surface`; a route the surface does not serve is a plain 404. */
export async function dispatch(rt: Runtime, req: Request, surface: Surface): Promise<Reply> {
  const path = new URL(req.url).pathname;
  if (req.method === "GET") {
    const found = getRoute(path, surface);
    if (found === null) return NOT_FOUND;
    return safely(rt, path, async () => found.route(rt, null, found.param));
  }
  const routes = POST_ROUTES[surface];
  const route = Object.hasOwn(routes, path) ? routes[path] : undefined;
  if (req.method !== "POST" || route === undefined) return NOT_FOUND;
  const json = await readJson(req);
  if (!json.ok) return { status: 400, body: { error: "invalid JSON" } };
  return safely(rt, path, async () => route(rt, json.body, ""));
}

function toResponse(r: Reply): Response {
  return r.status === 204 || r.body === null
    ? new Response(null, { status: r.status })
    : Response.json(r.body, { status: r.status });
}

/** The request handler for one surface's listeners; tracks in-flight requests for draining. */
export function createHandler(rt: Runtime, inflight: Set<Promise<unknown>>, surface: Surface) {
  return async (req: Request): Promise<Response> => {
    const work = dispatch(rt, req, surface);
    inflight.add(work);
    try {
      return toResponse(await work);
    } finally {
      inflight.delete(work);
    }
  };
}
