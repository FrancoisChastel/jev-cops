/** Severity of a log line; `debug` is dropped unless the logger is built with `debug`. */
export type LogLevel = "debug" | "info" | "warn" | "error";

/** Structured logging for the daemon; library code never writes to stdout. */
export interface Logger {
  log(level: LogLevel, msg: string, fields?: Readonly<Record<string, unknown>>): void;
}

/**
 * One JSON object per line on stderr: `{ at, level, msg, ...fields }`. Debug lines (for
 * example why `env.git` was not derived) only with `debug: true` (`JEV_COPS_DEBUG=1`).
 */
export function stderrLogger(
  now: () => number = Date.now,
  opts: { readonly debug?: boolean } = {},
): Logger {
  return {
    log(level, msg, fields = {}) {
      if (level === "debug" && opts.debug !== true) return;
      const line = { at: new Date(now()).toISOString(), level, msg, ...fields };
      process.stderr.write(`${JSON.stringify(line)}\n`);
    },
  };
}

/** Drops everything (tests). */
export const SILENT_LOGGER: Logger = Object.freeze({ log: () => undefined });
