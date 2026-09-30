/**
 * Per-command help, cut from the one `CLI_USAGE` text so a command's help can never drift
 * from the main usage: its entries (an entry starts at a two-space indented line whose
 * first word is the command, and continues on the more deeply indented lines below it)
 * and the exit-code lines, the shared ones plus any that name the command.
 */

const ENTRY = /^ {2}(\S+)/;
const CONTINUATION = /^ {3,}\S/;
const SHARED_EXIT = /^ {2}[0-9] /;
const EXIT_WRAP = /^ {5}\S/;

/** True when `args` asks for help: exactly `--help` or `-h`, anywhere. */
export function wantsHelp(args: readonly string[]): boolean {
  return args.some((a) => a === "--help" || a === "-h");
}

function section(lines: readonly string[], title: string): string[] {
  const start = lines.findIndex((l) => l === title);
  if (start < 0) return [];
  const end = lines.findIndex((l, i) => i > start && l.trim() === "");
  return lines.slice(start + 1, end < 0 ? undefined : end);
}

function entriesFor(name: string, commands: readonly string[]): string[] {
  const out: string[] = [];
  let inEntry = false;
  for (const line of commands) {
    const head = ENTRY.exec(line);
    if (head !== null) inEntry = head[1] === name;
    else if (!CONTINUATION.test(line)) inEntry = false;
    if (inEntry) out.push(line);
  }
  return out;
}

function exitLinesFor(name: string, exits: readonly string[]): string[] {
  const out: string[] = [];
  let keep = false;
  for (const line of exits) {
    if (SHARED_EXIT.test(line)) keep = true;
    else if (ENTRY.test(line))
      keep = line.startsWith(`  ${name} `) || line.startsWith(`  ${name}:`);
    else if (!EXIT_WRAP.test(line)) keep = false;
    if (keep) out.push(line);
  }
  return out;
}

/** The help for `name` cut from `usage`, or null when `usage` lists no such command. */
export function commandHelp(name: string, usage: string): string | null {
  const lines = usage.split("\n");
  const entries = entriesFor(name, section(lines, "Commands:"));
  if (entries.length === 0) return null;
  const title = lines[0] ?? "cops";
  const exits = exitLinesFor(name, section(lines, "Exit codes:"));
  return [
    title,
    "",
    `Usage: cops ${name} [options]`,
    "",
    ...entries,
    "",
    "Exit codes:",
    ...exits,
  ].join("\n");
}
