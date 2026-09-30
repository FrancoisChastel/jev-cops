/**
 * What `cops service install|uninstall` will do, decided before anything is touched: the unit
 * file and its rendered content, what is there now, and the service-manager steps to run
 * before and after the file changes. Reads the current unit file; writes nothing.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { err, ok, type Result } from "@jev-cops/core";
import type { ServiceContext } from "./context.ts";
import { launchdInstallSteps, launchdUninstallSteps, renderLaunchdPlist } from "./launchd.ts";
import { renderSystemdUnit, systemdInstallSteps, systemdUninstallSteps } from "./systemd.ts";
import {
  type DaemonProgram,
  logPath,
  managerOf,
  resolveDaemonProgram,
  type ServiceManager,
  type ServicePlatform,
  type Step,
  servicePathEnv,
  serviceSpec,
  unitPath,
} from "./units.ts";

/** One `install` or `uninstall`, fully decided. */
export interface ServicePlan {
  readonly action: "install" | "uninstall";
  readonly platform: ServicePlatform;
  readonly manager: ServiceManager;
  readonly unitPath: string;
  readonly logPath: string;
  /** Install only: the daemon program and the unit that starts it. */
  readonly program: DaemonProgram | null;
  readonly content: string | null;
  /** The unit file's current content, null when there is none. */
  readonly previous: string | null;
  readonly before: readonly Step[];
  readonly after: readonly Step[];
}

/** The file's content, or null when it does not exist (or cannot be read). */
export function readIfExists(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

/** The daemon program and the rendered unit for `platform` under `ctx.home`. */
export function expectedUnit(
  ctx: ServiceContext,
  platform: ServicePlatform,
): Result<{ program: DaemonProgram; content: string }, string> {
  const program = resolveDaemonProgram(ctx.runtime, {
    resolveEntry: ctx.resolveDaemonEntry,
    pathEnv: servicePathEnv(platform, ctx.home),
  });
  if (!program.ok) return program;
  const spec = serviceSpec(platform, ctx.home, program.value.program);
  const content = platform === "darwin" ? renderLaunchdPlist(spec) : renderSystemdUnit(spec);
  return content.ok ? ok({ program: program.value, content: content.value }) : content;
}

/** Install: render, compare with what is there, bootstrap or enable (restart when replacing). */
export function planInstall(
  ctx: ServiceContext,
  platform: ServicePlatform,
): Result<ServicePlan, string> {
  const expected = expectedUnit(ctx, platform);
  if (!expected.ok) return err(expected.error);
  const manager = managerOf(platform);
  const path = unitPath(manager, ctx.home);
  const previous = readIfExists(path);
  const replacing = previous !== null;
  const after =
    manager === "launchd"
      ? launchdInstallSteps(ctx.launchctl, ctx.uid, path, replacing)
      : systemdInstallSteps(ctx.systemctl, replacing);
  return ok({
    action: "install",
    platform,
    manager,
    unitPath: path,
    logPath: logPath(ctx.home),
    program: expected.value.program,
    content: expected.value.content,
    previous,
    before: [],
    after,
  });
}

/** Uninstall: boot out or disable first, then remove the file (then reload, for systemd). */
export function planUninstall(ctx: ServiceContext, platform: ServicePlatform): ServicePlan {
  const manager = managerOf(platform);
  const path = unitPath(manager, ctx.home);
  const previous = readIfExists(path);
  const steps =
    manager === "launchd"
      ? { before: launchdUninstallSteps(ctx.launchctl, ctx.uid), after: [] }
      : previous === null
        ? { before: [], after: [] }
        : systemdUninstallSteps(ctx.systemctl);
  return {
    action: "uninstall",
    platform,
    manager,
    unitPath: path,
    logPath: logPath(ctx.home),
    program: null,
    content: null,
    previous,
    ...steps,
  };
}

/**
 * Why the service-manager commands must not run here, or null: a dry run, a unit rendered
 * for another platform, or a `--home` that is not this user's (its unit would load into the
 * real user's session).
 */
export function runBlocker(
  ctx: ServiceContext,
  platform: ServicePlatform,
  dryRun: boolean,
): string | null {
  if (dryRun) return "dry run";
  if (ctx.platform !== platform)
    return `this machine is ${ctx.platform}, the unit is for ${platform}`;
  if (resolve(ctx.home) !== resolve(ctx.realHome)) {
    return `--home ${ctx.home} is not this user's home (${ctx.realHome})`;
  }
  return null;
}
