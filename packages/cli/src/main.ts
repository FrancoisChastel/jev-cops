#!/usr/bin/env bun
import { registerSdkModule } from "@jev-cops/sdk/register";
import { runAuditCommand } from "./commands/audit.ts";
import { runBudgetCommand } from "./commands/budget.ts";
import { runDoctorCommand } from "./commands/doctor.ts";
import { runExplainCommand } from "./commands/explain.ts";
import { runHookCommand } from "./commands/hook.ts";
import { INSTALL_USAGE, runInstallCommand } from "./commands/install.ts";
import { runKeygenCommand } from "./commands/keygen.ts";
import { OPENSHELL_USAGE, runOpenShellCommand } from "./commands/openshell.ts";
import { runReplayCommand } from "./commands/replay.ts";
import { runTestCommand } from "./commands/test.ts";
import { EXIT, type Io, PROCESS_IO } from "./io.ts";
import { CLI_VERSION } from "./version.ts";

export { CLI_VERSION };

export const CLI_USAGE = `cops ${CLI_VERSION} — the jev-cops command line

Usage: cops <command> [options]

Commands:
  test [dir] [--json]                      run every *.fixtures.json in dir (default ./policies)
                                           against its policy alone and with the whole set
  explain <event-id> [--audit path] [--json]
                                           show a judged event's decision, features, trace,
                                           normalized command and human detail (no daemon needed)
  replay <audit.jsonl> [--policies dir] [--json]
                                           re-judge recorded events with the current policies
                                           (default: the starter set copsd defaults to) and
                                           print verdict deltas (event_id old → new)
  budget <session-id> [--socket path] [--reset --admin-socket path]
                                           show a session's risk budget (agent socket), or
                                           reset it (admin socket: human only, H1)
  hook --harness claude-code [--socket path]
                                           the Claude Code command hook: reads the hook
                                           payload on stdin, exits 0 or 2 (fail closed)
  doctor [--harness claude-code|pi|all] [--live] [--json] [--socket path]
         [--admin-socket path] [--config path] [--home path]
         [--audit-pubkey path] [--audit-remote copy]
                                           check copsd, the audit log (chain, signed
                                           checkpoints, signing key, forwarding, and the
                                           off-box copy with --audit-remote), each harness's
                                           install, run a canary through the registered
                                           hook, print every known gap; --live also runs
                                           a real claude -p (JEV_COPS_LIVE_CANARY=1).
                                           It writes no configuration; the canary leaves
                                           audit lines and latches a throw-away session
                                           in copsd
${INSTALL_USAGE}
  keygen [--rotate] [--config path] [--admin-socket path] [--json]
                                           create the Ed25519 key copsd signs audit
                                           checkpoints with ([audit] key, 0600) and its
                                           public key for the cyber team; --rotate leaves
                                           the next key pending and asks a running copsd
                                           to switch (a rotation checkpoint signed by the
                                           old key), else it switches at its next start
  audit verify <audit.jsonl> --pubkey <file> [--pubkey <file>] [--remote <copy>] [--json]
                                           verify the hash chain, every signed checkpoint
                                           (following key rotations) and the unsigned tail;
                                           with --remote, that the off-box copy (JSONL or
                                           RFC 5424/5425 syslog) agrees: a longer copy is a
                                           local truncation (no daemon needed)
${OPENSHELL_USAGE}
  help                                     this text

Exit codes:
  0  success (test: every fixture passed; replay: ran, whatever the delta count;
     doctor: no check failed, warnings and gaps included)
  1  failure (a fixture mismatch or loader problem, an unknown event or unreadable log,
     an unknown session or an unreachable daemon; doctor: a check failed)
  2  usage error; hook: the call is blocked
  install: 0 installed (or already, removed, a dry run), 1 refused or failed, 2 usage
  audit verify: 0 verified (warnings included), 1 a check failed or input unreadable, 2 usage
  openshell: 0 ok, 1 refused or failed, 2 usage, 3 changes (compile or apply --dry-run)`;

type Command = (argv: readonly string[], io: Io) => Promise<number>;

/** Every command by name; the M0 subset of spec §Repo layout `cli/`. */
export const COMMANDS: Readonly<Record<string, Command>> = {
  test: runTestCommand,
  explain: runExplainCommand,
  replay: runReplayCommand,
  budget: runBudgetCommand,
  hook: runHookCommand,
  install: runInstallCommand,
  doctor: runDoctorCommand,
  keygen: runKeygenCommand,
  audit: runAuditCommand,
  openshell: runOpenShellCommand,
};

/** Runs `jev-cops` with `argv` (without the binary name); resolves with the exit code. */
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
    io.err(`jev-cops: unknown command "${name}"\n\n${CLI_USAGE}`);
    return EXIT.usage;
  }
  return command(rest, io);
}

if (import.meta.main) {
  registerSdkModule();
  process.exit(await main(process.argv.slice(2)));
}
