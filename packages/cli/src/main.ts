#!/usr/bin/env bun
import { runBudgetCommand } from "./commands/budget.ts";
import { runExplainCommand } from "./commands/explain.ts";
import { runReplayCommand } from "./commands/replay.ts";
import { runTestCommand } from "./commands/test.ts";
import { EXIT, type Io, PROCESS_IO } from "./io.ts";

/** CLI version; follows the workspace. */
export const CLI_VERSION = "0.0.0";

export const CLI_USAGE = `jevdict ${CLI_VERSION} — the Jevdict command line

Usage: jevdict <command> [options]

Commands:
  test [dir] [--json]                      run every *.fixtures.json in dir (default ./policies)
                                           against its policy alone and with the whole set
  explain <event-id> [--audit path] [--json]
                                           show a judged event's decision, features, trace,
                                           normalized command and human detail (no daemon needed)
  replay <audit.jsonl> [--policies dir] [--json]
                                           re-judge recorded events with the current policies
                                           and print verdict deltas (event_id old → new)
  budget <session-id> [--reset] [--socket path]
                                           show or reset a session's risk budget (running daemon)
  help                                     this text
  install, doctor                          not yet available (M1)

Exit codes:
  0  success (test: every fixture passed; replay: ran, whatever the delta count)
  1  failure (a fixture mismatch or loader problem, an unknown event or unreadable log,
     an unknown session or an unreachable daemon)
  2  usage error, or a command that is not available yet`;

type Command = (argv: readonly string[], io: Io) => Promise<number>;

const notYet =
  (name: string): Command =>
  async (_argv, io) => {
    io.err(`jevdict ${name}: not yet available (M1)`);
    return EXIT.usage;
  };

/** Every command by name; the M0 subset of spec §Repo layout `cli/`. */
export const COMMANDS: Readonly<Record<string, Command>> = {
  test: runTestCommand,
  explain: runExplainCommand,
  replay: runReplayCommand,
  budget: runBudgetCommand,
  install: notYet("install"),
  doctor: notYet("doctor"),
};

/** Runs `jevdict` with `argv` (without the binary name); resolves with the exit code. */
export async function main(argv: readonly string[], io: Io = PROCESS_IO): Promise<number> {
  const [name, ...rest] = argv;
  if (name === undefined || name === "help" || name === "--help" || name === "-h") {
    io.out(CLI_USAGE);
    return name === undefined ? EXIT.usage : EXIT.ok;
  }
  if (name === "--version") {
    io.out(CLI_VERSION);
    return EXIT.ok;
  }
  const command = COMMANDS[name];
  if (command === undefined) {
    io.err(`jevdict: unknown command "${name}"\n\n${CLI_USAGE}`);
    return EXIT.usage;
  }
  return command(rest, io);
}

if (import.meta.main) {
  process.exit(await main(process.argv.slice(2)));
}
