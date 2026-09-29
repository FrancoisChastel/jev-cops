import { chmodSync, existsSync, mkdirSync, unlinkSync } from "node:fs";
import { dirname } from "node:path";
import type { Server } from "bun";
import type { DaemonConfig, HttpBind } from "./config.ts";
import { createRuntime, type DaemonDeps, type Runtime } from "./daemon.ts";
import { createHandler } from "./routes.ts";

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
  /** The agent-facing socket (the one a sandbox mounts). */
  readonly socket: string;
  /** The human-only socket (budget reset); never mounted into a sandbox. */
  readonly adminSocket: string;
  /** `http://127.0.0.1:<port>` when HTTP is on; it serves the agent-facing routes. */
  readonly httpUrl: string | null;
  stop(): Promise<void>;
}

/** The listeners to open: both Unix sockets and optional loopback HTTP. */
export interface ListenOptions {
  readonly socket: string;
  readonly adminSocket: string;
  readonly http: HttpBind | null;
}

function serveUnix(fetch: ReturnType<typeof createHandler>, path: string): Server<undefined> {
  const server = Bun.serve({ fetch, maxRequestBodySize: MAX_BODY_BYTES, unix: path });
  chmodSync(path, 0o600);
  return server;
}

/** Opens every listener; if one fails, the ones already open are closed again. */
function openServers(rt: Runtime, opts: ListenOptions, inflight: Set<Promise<unknown>>) {
  const agent = createHandler(rt, inflight, "agent");
  const servers: Server<undefined>[] = [];
  let web: Server<undefined> | null = null;
  try {
    servers.push(serveUnix(agent, opts.socket));
    servers.push(serveUnix(createHandler(rt, inflight, "admin"), opts.adminSocket));
    if (opts.http !== null) {
      const { host: hostname, port } = opts.http;
      web = Bun.serve({ fetch: agent, maxRequestBodySize: MAX_BODY_BYTES, hostname, port });
      servers.push(web);
    }
  } catch (cause) {
    for (const s of servers) s.stop(true);
    throw cause;
  }
  return { servers, web };
}

/**
 * Listens on the agent socket and the admin socket (both mode 0600, in 0700 directories)
 * and, when configured, on loopback HTTP only (agent routes). The two sockets must
 * differ. `stop` stops accepting, waits up to 2 s for in-flight requests, removes both
 * sockets.
 */
export async function listen(
  rt: Runtime,
  opts: ListenOptions = rt.config.daemon,
): Promise<Listening> {
  if (opts.http !== null) assertLoopback(opts.http.host);
  if (opts.socket === opts.adminSocket) {
    throw new Error(`the agent and admin sockets must differ: ${opts.socket}`);
  }
  await prepareSocket(opts.socket);
  await prepareSocket(opts.adminSocket);
  const inflight = new Set<Promise<unknown>>();
  const { servers, web } = openServers(rt, opts, inflight);
  return {
    socket: opts.socket,
    adminSocket: opts.adminSocket,
    httpUrl: web === null ? null : `http://${opts.http?.host}:${web.port}`,
    async stop() {
      for (const s of servers) s.stop(true);
      const drained = Promise.allSettled([...inflight]);
      await Promise.race([drained, new Promise((r) => setTimeout(r, DRAIN_MS))]);
      for (const path of [opts.socket, opts.adminSocket]) if (existsSync(path)) unlinkSync(path);
    },
  };
}

/** A running daemon: its runtime and listeners, and one call to shut both down. */
export interface RunningDaemon {
  readonly runtime: Runtime;
  readonly listening: Listening;
  /** Idempotent: a second call waits for the first. */
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
  let stopping: Promise<void> | null = null;
  return {
    runtime,
    listening,
    stop() {
      stopping ??= listening.stop().then(() => runtime.close());
      return stopping;
    },
  };
}
