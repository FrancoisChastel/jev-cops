import { chmodSync, existsSync, mkdirSync, unlinkSync } from "node:fs";
import { dirname } from "node:path";
import type { Server } from "bun";
import type { DaemonConfig, HttpBind } from "./config.ts";
import { createRuntime, type DaemonDeps, type Runtime } from "./daemon.ts";
import {
  handleBudget,
  handleBudgetReset,
  handleExplain,
  handleHealth,
  handleResolve,
} from "./human.ts";
import { handleJudge, handleObserve, type Reply } from "./service.ts";

/** Largest request body accepted (an event with a big Write is well under this). */
export const MAX_BODY_BYTES = 1_048_576;
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);
const DRAIN_MS = 2_000;
/** `sun_path` holds 104 bytes on macOS (108 on Linux) including the NUL; stay under both. */
export const MAX_SOCKET_PATH_BYTES = 103;

/** Throws unless `host` is a loopback address (T13: never reachable off the host). */
export function assertLoopback(host: string): void {
  if (!LOOPBACK_HOSTS.has(host)) {
    throw new Error(`refusing to bind HTTP on non-loopback address "${host}"`);
  }
}

function message(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function toResponse(r: Reply): Response {
  return r.status === 204 || r.body === null
    ? new Response(null, { status: r.status })
    : Response.json(r.body, { status: r.status });
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

type Route = (rt: Runtime, body: unknown, param: string) => Reply | Promise<Reply>;

const POST_ROUTES: Readonly<Record<string, Route>> = {
  "/v1/judge": (rt, body) => withDeadline(rt, handleJudge(rt, body), body),
  "/v1/observe": (rt, body) => handleObserve(rt, body),
  "/v1/resolve": (rt, body) => handleResolve(rt, body),
  "/v1/budget/reset": (rt, body) => handleBudgetReset(rt, body),
};

function getRoute(path: string): { route: Route; param: string } | null {
  if (path === "/v1/health") return { route: (rt) => handleHealth(rt), param: "" };
  const m = /^\/v1\/(explain|budget)\/([^/]+)$/.exec(path);
  if (m === null) return null;
  const param = decodeURIComponent(m[2] ?? "");
  const route: Route =
    m[1] === "explain" ? (rt, _b, p) => handleExplain(rt, p) : (rt, _b, p) => handleBudget(rt, p);
  return { route, param };
}

async function dispatch(rt: Runtime, req: Request): Promise<Reply> {
  const path = new URL(req.url).pathname;
  if (req.method === "GET") {
    const found = getRoute(path);
    if (found === null) return { status: 404, body: { error: "not found" } };
    return safely(rt, path, async () => found.route(rt, null, found.param));
  }
  const route = POST_ROUTES[path];
  if (req.method !== "POST" || route === undefined) {
    return { status: 404, body: { error: "not found" } };
  }
  const json = await readJson(req);
  if (!json.ok) return { status: 400, body: { error: "invalid JSON" } };
  return safely(rt, path, async () => route(rt, json.body, ""));
}

/** The request handler for both listeners; tracks in-flight requests for draining. */
export function createHandler(rt: Runtime, inflight: Set<Promise<unknown>>) {
  return async (req: Request): Promise<Response> => {
    const work = dispatch(rt, req);
    inflight.add(work);
    try {
      return toResponse(await work);
    } finally {
      inflight.delete(work);
    }
  };
}

async function socketInUse(path: string): Promise<boolean> {
  try {
    const res = await fetch("http://localhost/v1/health", {
      unix: path,
      signal: AbortSignal.timeout(500),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Creates the socket's directory (0700) and removes a stale socket; throws if one is
 * live, or if the path is too long for `sun_path` (the bind would silently truncate it
 * and the adapter could never connect).
 */
async function prepareSocket(path: string): Promise<void> {
  const bytes = Buffer.byteLength(path);
  if (bytes > MAX_SOCKET_PATH_BYTES) {
    throw new Error(
      `socket path is ${bytes} bytes; the limit is ${MAX_SOCKET_PATH_BYTES}: ${path}`,
    );
  }
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  if (!existsSync(path)) return;
  if (await socketInUse(path)) throw new Error(`jevdictd is already running on ${path}`);
  unlinkSync(path);
}

/** Where the daemon listens, and how to stop listening. */
export interface Listening {
  readonly socket: string;
  /** `http://127.0.0.1:<port>` when HTTP is on. */
  readonly httpUrl: string | null;
  stop(): Promise<void>;
}

/**
 * Listens on the Unix socket (mode 0600) and, when configured, on loopback HTTP only.
 * `stop` stops accepting, waits up to 2 s for in-flight requests, removes the socket.
 */
export async function listen(
  rt: Runtime,
  opts: { socket: string; http: HttpBind | null } = rt.config.daemon,
): Promise<Listening> {
  if (opts.http !== null) assertLoopback(opts.http.host);
  await prepareSocket(opts.socket);
  const inflight = new Set<Promise<unknown>>();
  const fetch = createHandler(rt, inflight);
  const common = { fetch, maxRequestBodySize: MAX_BODY_BYTES };
  const servers: Server<undefined>[] = [Bun.serve({ ...common, unix: opts.socket })];
  chmodSync(opts.socket, 0o600);
  if (opts.http !== null) {
    servers.push(Bun.serve({ ...common, hostname: opts.http.host, port: opts.http.port }));
  }
  const web = servers[1];
  return {
    socket: opts.socket,
    httpUrl: web === undefined ? null : `http://${opts.http?.host}:${web.port}`,
    async stop() {
      for (const s of servers) s.stop(true);
      const drained = Promise.allSettled([...inflight]);
      await Promise.race([drained, new Promise((r) => setTimeout(r, DRAIN_MS))]);
      if (existsSync(opts.socket)) unlinkSync(opts.socket);
    },
  };
}

/** A running daemon: its runtime and listeners, and one call to shut both down. */
export interface RunningDaemon {
  readonly runtime: Runtime;
  readonly listening: Listening;
  stop(): Promise<void>;
}

/** Builds the runtime from `config` and starts listening; closes the runtime on failure. */
export async function startDaemon(
  config: DaemonConfig,
  deps: DaemonDeps = {},
): Promise<RunningDaemon> {
  const runtime = await createRuntime(config, deps);
  let listening: Listening;
  try {
    listening = await listen(runtime);
  } catch (cause) {
    runtime.close();
    throw cause;
  }
  return {
    runtime,
    listening,
    async stop() {
      await listening.stop();
      runtime.close();
    },
  };
}
