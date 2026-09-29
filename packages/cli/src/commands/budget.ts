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

/**
 * `jevdict budget <session-id> [--reset] [--socket path]`: shows (or, with `--reset`,
 * resets) a session's risk budget through the running daemon (spec: "until a human
 * resets the budget"). Exit 1 when the daemon is unreachable or the session unknown.
 */
export async function runBudgetCommand(argv: readonly string[], io: Io): Promise<number> {
  let parsed: { values: { reset?: boolean; socket?: string }; positionals: string[] };
  try {
    parsed = parseArgs({
      args: [...argv],
      options: { reset: { type: "boolean" }, socket: { type: "string" } },
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
  const socket = parsed.values.socket ?? configuredPaths().socket;
  try {
    const res =
      parsed.values.reset === true
        ? await request(socket, "/v1/budget/reset", { session_id: sessionId })
        : await request(socket, `/v1/budget/${encodeURIComponent(sessionId)}`);
    if (res.status !== 200) {
      io.err(`jevdict budget: ${String(res.body.error ?? `HTTP ${res.status}`)}`);
      return EXIT.failed;
    }
    const verb = parsed.values.reset === true ? "reset; now" : "spent";
    io.out(`${sessionId}: ${verb} ${String(res.body.spent)}/${String(res.body.limit)}`);
    return EXIT.ok;
  } catch (cause) {
    io.err(`jevdict budget: daemon unreachable on ${socket}: ${(cause as Error).message}`);
    return EXIT.failed;
  }
}
