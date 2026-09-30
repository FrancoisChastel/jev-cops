/**
 * `cops service status`: whether the unit is installed and matches what `install` would write
 * now, what the service manager says (`launchctl print` / `systemctl --user show`, read-only,
 * only for this platform and this user's home), and the last lines of copsd's log. It only
 * reads.
 */
import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import type { ServiceContext } from "./context.ts";
import { launchdStatusStep, parseLaunchctlPrint } from "./launchd.ts";
import { expectedUnit, readIfExists, runBlocker } from "./plan.ts";
import { parseSystemctlShow, systemdStatusStep } from "./systemd.ts";
import {
  type DaemonProgram,
  logPath,
  type ManagerState,
  managerOf,
  type ServiceManager,
  type ServicePlatform,
  unitPath,
} from "./units.ts";

/** Lines of the log `status` (and a failed `install`) print. */
export const LOG_TAIL_LINES = 20;
const LOG_TAIL_BYTES = 64 * 1024;

/** Everything `status` reports. */
export interface ServiceStatus {
  readonly platform: ServicePlatform;
  readonly manager: ServiceManager;
  readonly unitPath: string;
  readonly logPath: string;
  readonly installed: boolean;
  /** Null when the expected unit cannot be rendered (see `expectedProblem`). */
  readonly upToDate: boolean | null;
  readonly expected: DaemonProgram | null;
  readonly expectedProblem: string | null;
  /** Null when the service manager was not asked (see `notQueried`). */
  readonly state: ManagerState | null;
  readonly notQueried: string | null;
  readonly logTail: readonly string[];
}

/** The last `lines` lines of the file at `path` (reading at most its last 64 KiB). */
export function logTail(path: string, lines: number = LOG_TAIL_LINES): string[] {
  let fd: number;
  try {
    fd = openSync(path, "r");
  } catch {
    return [];
  }
  try {
    const size = fstatSync(fd).size;
    const length = Math.min(size, LOG_TAIL_BYTES);
    const buf = Buffer.alloc(length);
    readSync(fd, buf, 0, length, size - length);
    const all = buf.toString("utf8").split("\n");
    if (all.at(-1) === "") all.pop();
    return all.slice(-lines);
  } finally {
    closeSync(fd);
  }
}

/** Asks the service manager about copsd (read-only). */
export async function queryManager(
  ctx: ServiceContext,
  manager: ServiceManager,
): Promise<ManagerState> {
  const step =
    manager === "launchd"
      ? launchdStatusStep(ctx.launchctl, ctx.uid)
      : systemdStatusStep(ctx.systemctl);
  const r = await ctx.run(step.argv);
  return manager === "launchd"
    ? parseLaunchctlPrint(r.code, r.stdout)
    : parseSystemctlShow(r.code, r.stdout);
}

/** The status of copsd's service for `platform` under `ctx.home`. */
export async function readStatus(
  ctx: ServiceContext,
  platform: ServicePlatform,
): Promise<ServiceStatus> {
  const manager = managerOf(platform);
  const path = unitPath(manager, ctx.home);
  const current = readIfExists(path);
  const expected = expectedUnit(ctx, platform);
  const blocker = runBlocker(ctx, platform, false);
  const log = logPath(ctx.home);
  return {
    platform,
    manager,
    unitPath: path,
    logPath: log,
    installed: current !== null,
    upToDate: expected.ok && current !== null ? current === expected.value.content : null,
    expected: expected.ok ? expected.value.program : null,
    expectedProblem: expected.ok ? null : expected.error,
    state: blocker === null ? await queryManager(ctx, manager) : null,
    notQueried: blocker,
    logTail: logTail(log),
  };
}
