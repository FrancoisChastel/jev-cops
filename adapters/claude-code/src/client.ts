/**
 * JSON over the daemon's agent Unix socket (Bun `fetch({ unix })`: the hook is a compiled
 * Bun binary). Each call takes its own deadline; a deadline that passes rejects with
 * {@link TIMEOUT}, any other failure with the transport error, and the caller fails closed
 * on both (D-055 parity). A reply's body that is not JSON is `undefined`.
 */
import type { PostEvent, PreEvent, SessionEvent } from "@jev-cops/core";

/** The reason every deadline failure carries (spec T3: "judge timeout"). */
export const TIMEOUT = "judge timeout";
/**
 * Response header carrying a Claude Code hold's view-only token (D-079); the daemon's
 * `VIEW_TOKEN_HEADER` (a test keeps the two equal without bundling the daemon's holds).
 */
export const VIEW_TOKEN_HEADER = "x-jev-cops-view-token";

/** A daemon reply: HTTP status, parsed JSON body (null when empty) and the view token. */
export interface Reply {
  readonly status: number;
  readonly body: unknown;
  readonly viewToken: string | null;
}

/** The routes the hook calls, each with a deadline in milliseconds. */
export interface DaemonClient {
  judge(event: PreEvent, ms: number): Promise<Reply>;
  observe(event: PostEvent, ms: number): Promise<Reply>;
  session(report: SessionEvent, ms: number): Promise<Reply>;
  confirmView(eventId: string, token: string, ms: number): Promise<Reply>;
}

function parseBody(text: string): unknown {
  if (text === "") return null;
  try {
    return JSON.parse(text);
  } catch {
    return undefined; // not JSON: no reply the hook can act on
  }
}

function isTimeout(cause: unknown): boolean {
  return cause instanceof Error && (cause.name === "TimeoutError" || cause.name === "AbortError");
}

interface Request {
  readonly method: "GET" | "POST";
  readonly path: string;
  readonly body?: unknown;
  readonly headers?: Readonly<Record<string, string>>;
}

async function send(socket: string, r: Request, ms: number): Promise<Reply> {
  try {
    const res = await fetch(`http://localhost${r.path}`, {
      method: r.method,
      unix: socket,
      signal: AbortSignal.timeout(Math.max(1, Math.floor(ms))),
      headers: { "content-type": "application/json", ...r.headers },
      ...(r.body === undefined ? {} : { body: JSON.stringify(r.body) }),
    });
    const body = parseBody(await res.text());
    return { status: res.status, body, viewToken: res.headers.get(VIEW_TOKEN_HEADER) };
  } catch (cause) {
    throw isTimeout(cause) ? new Error(TIMEOUT) : cause;
  }
}

/** A client for the daemon's agent socket at `socket`. */
export function createClient(socket: string): DaemonClient {
  const post = (path: string, body: unknown, ms: number) =>
    send(socket, { method: "POST", path, body }, ms);
  return {
    judge: (event, ms) => post("/v1/judge", event, ms),
    observe: (event, ms) => post("/v1/observe", event, ms),
    session: (report, ms) => post("/v1/session", report, ms),
    confirmView: (eventId, token, ms) => {
      const path = `/v1/explain/${encodeURIComponent(eventId)}`;
      return send(
        socket,
        { method: "GET", path, headers: { authorization: `Bearer ${token}` } },
        ms,
      );
    },
  };
}
