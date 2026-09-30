/** Text helpers for what `cops service` prints: bounded one-liners and copy-pastable commands. */

const MAX_LINE = 300;

/** `text` on one line (whitespace and controls collapsed), at most `max` characters. */
export function oneLineOf(text: string, max: number = MAX_LINE): string {
  const flat = text.replace(/[\s\p{Cc}]+/gu, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

/** `arg` as one POSIX shell word: bare when it is plain, else single-quoted. */
export function shellQuote(arg: string): string {
  if (/^[A-Za-z0-9_./:@%+=,-]+$/.test(arg)) return arg;
  return `'${arg.replaceAll("'", `'"'"'`)}'`;
}

/** An argv as a command line a human can paste into a shell. */
export function commandLine(argv: readonly string[]): string {
  return argv.map(shellQuote).join(" ");
}
