/**
 * `cops install pi [--global|--project] [--socket path] [--home dir] [--project-dir dir]
 * [--dry-run] [--uninstall] [--json]`: wraps the Pi adapter's `installPiExtension` (M0)
 * with the same conventions as `install claude-code`, and prints `PI_GAPS`.
 */

import { resolve } from "node:path";
import {
  type InstallOptions,
  installPiExtension,
  PI_GAPS,
  uninstallPiExtension,
} from "@jev-cops/adapter-pi/install";
import { EXIT, type Io } from "../io.ts";
import type { PiInstallArgs } from "./install-args.ts";
import type { InstallContext } from "./install-context.ts";
import { resolveBase, socketProblem } from "./install-setup.ts";

function optionsOf(a: PiInstallArgs, ctx: InstallContext, lines: string[]): InstallOptions {
  const base = resolveBase(a, ctx);
  lines.push(...base.warnings.map((w) => `jev-cops: warning: ${w}`));
  return {
    global: a.global,
    projectDir: base.projectDir,
    home: base.home,
    env: base.env,
    dryRun: a.dryRun,
    ...(a.socket === null ? {} : { socket: resolve(ctx.cwd, a.socket) }),
    print: (l) => {
      lines.push(l);
    },
  };
}

function run(a: PiInstallArgs, o: InstallOptions) {
  if (!a.uninstall) {
    const r = installPiExtension(o);
    return { action: "install", path: r.path, socket: r.socket, written: r.written };
  }
  const r = uninstallPiExtension(o);
  o.print?.("jev-cops: known gaps (see docs/adapters.md#pi):");
  for (const gap of PI_GAPS) o.print?.(`  - ${gap}`);
  return { action: "uninstall", path: r.path, present: r.present, removed: r.removed };
}

/** Runs `cops install pi`; resolves with the exit code. */
export function runPiInstall(a: PiInstallArgs, ctx: InstallContext, io: Io): number {
  const lines: string[] = [];
  const o = optionsOf(a, ctx, lines);
  const bad = o.socket === undefined ? null : socketProblem(o.socket);
  try {
    if (bad !== null) throw new Error(bad);
    const done = run(a, o);
    if (a.json)
      io.out(JSON.stringify({ harness: "pi", ok: true, dryRun: a.dryRun, ...done, gaps: PI_GAPS }));
    else for (const l of lines) io.out(l);
    return EXIT.ok;
  } catch (cause) {
    const error = cause instanceof Error ? cause.message : String(cause);
    if (a.json) io.out(JSON.stringify({ harness: "pi", ok: false, error }));
    else io.err(`jev-cops: error: ${error}`);
    return EXIT.failed;
  }
}
