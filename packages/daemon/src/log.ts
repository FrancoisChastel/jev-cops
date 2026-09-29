/** Severity of a log line. */
export type LogLevel = "info" | "warn" | "error";

/** Structured logging for the daemon; library code never writes to stdout. */
export interface Logger {
  log(level: LogLevel, msg: string, fields?: Readonly<Record<string, unknown>>): void;
}

/** One JSON object per line on stderr: `{ at, level, msg, ...fields }`. */
export function stderrLogger(now: () => number = Date.now): Logger {
  return {
    log(level, msg, fields = {}) {
      const line = { at: new Date(now()).toISOString(), level, msg, ...fields };
      process.stderr.write(`${JSON.stringify(line)}\n`);
    },
  };
}

/** Drops everything (tests). */
export const SILENT_LOGGER: Logger = Object.freeze({ log: () => undefined });
