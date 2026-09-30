/**
 * `cops install claude-code|pi [options]` (PLAN-M1 §4.3). Exit codes: 0 installed (or
 * already, removed, a dry run), 1 refused or failed, 2 usage. Every path comes from the
 * injected {@link InstallContext}; `--home` confines the run to another home directory.
 */

import { resolve } from "node:path";
import { InstallError } from "@jev-cops/adapter-claude-code";
import { EXIT, type Io } from "../io.ts";
import { type ClaudeInstallArgs, parseInstallArgs } from "./install-args.ts";
import { installClaudeCode, uninstallClaudeCode } from "./install-claude-code.ts";
import { type InstallContext, processContext } from "./install-context.ts";
import { runPiInstall } from "./install-pi.ts";
import { type ClaudeReport, emptyReport, exitCodeOf, printClaudeReport } from "./install-report.ts";
import { resolveSetup } from "./install-setup.ts";

/** Usage lines for `cops --help`. */
export const INSTALL_USAGE = `  install claude-code [--user|--project|--local|--managed] [--socket path]
          [--transport command|http] [--hook-binary path] [--config path] [--home dir]
          [--project-dir dir] [--force] [--dry-run] [--uninstall] [--json]
                                           register the command hook in Claude Code's settings,
                                           record it in cops.toml, run the offline canary
  install pi [--global|--project] [--socket path] [--home dir] [--project-dir dir]
          [--dry-run] [--uninstall] [--json]
                                           copy the Pi extension (global by default)`;

function failure(a: ClaudeInstallArgs, error: string, content: string | null): ClaudeReport {
  const errors = content === null ? [error] : [error, `intended content:\n${content}`];
  return { ...emptyReport(a.uninstall ? "uninstall" : "install", a, null), errors };
}

async function claudeCode(a: ClaudeInstallArgs, ctx: InstallContext): Promise<ClaudeReport> {
  const setup = resolveSetup(a, ctx);
  if (!setup.ok) return failure(a, setup.error, null);
  try {
    if (a.uninstall) {
      const hookBinary = a.hookBinary === null ? null : resolve(ctx.cwd, a.hookBinary);
      return uninstallClaudeCode(a, setup.setup, ctx, hookBinary);
    }
    return await installClaudeCode(a, setup.setup, ctx);
  } catch (cause) {
    if (cause instanceof InstallError) return failure(a, cause.message, cause.content);
    throw cause;
  }
}

/** Runs `cops install`; resolves with the exit code. */
export async function runInstallCommand(
  argv: readonly string[],
  io: Io,
  ctx: InstallContext = processContext(),
): Promise<number> {
  const parsed = parseInstallArgs(argv);
  if (!parsed.ok) {
    io.err(`jev-cops install: ${parsed.error}\n\nUsage:\n${INSTALL_USAGE}`);
    return EXIT.usage;
  }
  const a = parsed.args;
  if (a.harness === "pi") return runPiInstall(a, ctx, io);
  const report = await claudeCode(a, ctx);
  printClaudeReport(report, io, a.json);
  return exitCodeOf(report);
}
