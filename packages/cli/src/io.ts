/** Where a command writes; tests capture it, the binary uses stdout/stderr. */
export interface Io {
  out(text: string): void;
  err(text: string): void;
}

/** The process's own stdout and stderr, one line per call. */
export const PROCESS_IO: Io = Object.freeze({
  out: (text: string) => {
    process.stdout.write(`${text}\n`);
  },
  err: (text: string) => {
    process.stderr.write(`${text}\n`);
  },
});

/** An {@link Io} that records every line, for tests. */
export function captureIo(): Io & { stdout: string[]; stderr: string[] } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    stdout,
    stderr,
    out: (t) => {
      stdout.push(t);
    },
    err: (t) => {
      stderr.push(t);
    },
  };
}

/** Exit codes shared by every command (documented in `cops --help`). */
export const EXIT = Object.freeze({ ok: 0, failed: 1, usage: 2 });
