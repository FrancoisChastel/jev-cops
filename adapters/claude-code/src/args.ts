/**
 * The hook's command line: `--harness claude-code [--socket path] [--http-url url]`, as the settings entry
 * passes it in exec form (plan §2 row 21: the socket is an argument, never an environment
 * variable). The same parser serves the compiled `cops-hook`, `cops hook` and the
 * ConfigChange check that the registered entry is still jev-cops's (intact.ts).
 */
import { isAbsolute, join } from "node:path";
import { parseArgs } from "node:util";
import { isLoopbackHttpUrl } from "./hook-entries.ts";

/** The daemon's default agent socket, relative to the home directory. */
export const DEFAULT_SOCKET_RELATIVE = ".jev-cops/copsd.sock";

/**
 * Parsed hook arguments, or why they are refused. `httpUrl` is the daemon's loopback URL
 * when the install registered post events over HTTP (`--transport http`): the ConfigChange
 * check accepts an HTTP post handler only to that URL (intact.ts).
 */
export type HookArgs =
  | {
      readonly ok: true;
      readonly harness: "claude-code";
      readonly socket: string;
      readonly httpUrl: string | null;
    }
  | { readonly ok: false; readonly error: string };

/** Why a harness other than Claude Code is refused. */
function harnessError(harness: string | undefined): string | null {
  if (harness === undefined) return "--harness claude-code is required";
  if (harness === "claude-code") return null;
  if (harness === "pi") return "pi is not a hook harness: install the Pi extension instead";
  return `unknown harness ${JSON.stringify(harness.slice(0, 32))}`;
}

/**
 * Parses the hook's arguments. The socket defaults to `~/.jev-cops/copsd.sock` under
 * `home`; an explicit one must be absolute. Unknown options and positionals are refused, so
 * a mistyped entry fails closed instead of talking to the wrong daemon.
 */
export function parseHookArgs(argv: readonly string[], home: string): HookArgs {
  let values: {
    harness?: string | undefined;
    socket?: string | undefined;
    "http-url"?: string | undefined;
  };
  try {
    const options = {
      harness: { type: "string" },
      socket: { type: "string" },
      "http-url": { type: "string" },
    } as const;
    ({ values } = parseArgs({ args: [...argv], options, strict: true, allowPositionals: false }));
  } catch (cause) {
    return { ok: false, error: cause instanceof Error ? cause.message : String(cause) };
  }
  const refused = harnessError(values.harness);
  if (refused !== null) return { ok: false, error: refused };
  const socket = values.socket ?? join(home, DEFAULT_SOCKET_RELATIVE);
  if (!isAbsolute(socket)) return { ok: false, error: `--socket must be absolute: ${socket}` };
  const httpUrl = values["http-url"] ?? null;
  if (httpUrl !== null && !isLoopbackHttpUrl(httpUrl)) {
    return { ok: false, error: `--http-url must be http://<loopback>:<port>: ${httpUrl}` };
  }
  return { ok: true, harness: "claude-code", socket, httpUrl };
}
