import { parseArgs } from "node:util";
import { configuredPaths } from "../config-paths.ts";
import { EXIT, type Io } from "../io.ts";

const REQUEST_TIMEOUT_MS = 5_000;

async function request(socket: string, path: string, body?: unknown) {
  const res = await fetch(`http://localhost${path}`, {
    method: body === undefined ? "GET" : "POST",
    unix: socket,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    ...(body === undefined
      ? {}
      : { body: JSON.stringify(body), headers: { "content-type": "application/json" } }),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

interface BudgetArgs {
  values: { reset?: boolean; socket?: string; "admin-socket"?: string };
  positionals: string[];
}

/**
 * `jevdict budget <session-id> [--socket path] [--reset --admin-socket path]`: shows a
 * session's risk budget through the daemon's agent socket, or, with `--reset`, resets it
 * through the admin socket, which only a human's shell reaches (spec: "until a human
 * resets the budget"; H1). Exit 1 when the daemon is unreachable or the session unknown.
 */
export async function runBudgetCommand(argv: readonly string[], io: Io): Promise<number> {
  let parsed: BudgetArgs;
  try {
    parsed = parseArgs({
      args: [...argv],
      options: {
        reset: { type: "boolean" },
        socket: { type: "string" },
        "admin-socket": { type: "string" },
      },
      allowPositionals: true,
      strict: true,
    });
  } catch (cause) {
    io.err(`jevdict budget: ${(cause as Error).message}`);
    return EXIT.usage;
  }
  const [sessionId, ...extra] = parsed.positionals;
  if (sessionId === undefined || extra.length > 0) {
    io.err("jevdict budget: expected exactly one session id");
    return EXIT.usage;
  }
  const reset = parsed.values.reset === true;
  const socket = reset
    ? (parsed.values["admin-socket"] ?? configuredPaths().adminSocket)
    : (parsed.values.socket ?? configuredPaths().socket);
  try {
    const res = reset
      ? await request(socket, "/v1/budget/reset", { session_id: sessionId })
      : await request(socket, `/v1/budget/${encodeURIComponent(sessionId)}`);
    if (res.status !== 200) {
      io.err(`jevdict budget: ${String(res.body.error ?? `HTTP ${res.status}`)}`);
      return EXIT.failed;
    }
    const verb = reset ? "reset; now" : "spent";
    io.out(`${sessionId}: ${verb} ${String(res.body.spent)}/${String(res.body.limit)}`);
    return EXIT.ok;
  } catch (cause) {
    io.err(`jevdict budget: daemon unreachable on ${socket}: ${(cause as Error).message}`);
    return EXIT.failed;
  }
}
