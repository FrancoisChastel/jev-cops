#!/usr/bin/env bun
import { runTestCommand } from "./commands/test.ts";
import { EXIT, type Io, PROCESS_IO } from "./io.ts";

/** CLI version; follows the workspace. */
export const CLI_VERSION = "0.0.0";

export const CLI_USAGE = `jevdict ${CLI_VERSION} — the Jevdict command line

Usage: jevdict <command> [options]

Commands:
  test [dir] [--json]                      run every *.fixtures.json in dir (default ./policies)
                                           against its policy alone and with the whole set
  help                                     this text
  install, doctor                          not yet available (M1)

Exit codes:
  0  success (test: every fixture passed)
  1  failure (a fixture mismatch or loader problem, an unknown event, an unreachable daemon)
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
