/**
 * `cops service install|uninstall|status` (PLAN-SETUP §7.3, S4): copsd as a login service, a
 * launchd user agent on macOS or a `systemd --user` unit on Linux. `install` renders the unit
 * under `--home` (default: the real home), writes it atomically, runs `launchctl bootstrap` /
 * `systemctl --user enable --now` and waits for `/v1/health`; `uninstall` stops it and removes
 * the unit (the log and the rest of `~/.jev-cops/` stay); `status` only reads. Service-manager
 * commands run only on the platform the unit is for, for this user's own home, and never with
 * `--dry-run`; otherwise they are printed. Exit codes: 0 done (`status`: running), 1 failed
 * (`status`: not installed or not running), 2 usage.
 */
import { ok } from "@jev-cops/core";
import { EXIT, type Io } from "../io.ts";
import { applyPlan } from "../service/apply.ts";
import { processServiceContext, type ServiceContext } from "../service/context.ts";
import { planInstall, planUninstall, runBlocker } from "../service/plan.ts";
import { readStatus } from "../service/status.ts";
import type { ServicePlatform } from "../service/units.ts";
import { parseServiceArgs, type ServiceArgs } from "./service-args.ts";
import {
  applyJson,
  applyLines,
  SERVICE_SCHEMA,
  statusJson,
  statusLines,
} from "./service-render.ts";

/** Usage lines for `cops --help`. */
export const SERVICE_USAGE = `  service install|uninstall|status [--home dir] [--platform darwin|linux]
          [--dry-run] [--json]
                                           run copsd as a login service: a launchd user
                                           agent (macOS) or a systemd --user unit (Linux);
                                           install writes the unit, loads it and waits for
                                           /v1/health, uninstall stops and removes it (the
                                           log stays), status only reads`;

/** Builds the context for a run; `home` is `--home` or null. Injected in tests. */
export type ServiceContextFactory = (home: string | null) => ServiceContext;

function hostPlatform(platform: NodeJS.Platform): ServicePlatform | null {
  return platform === "darwin" || platform === "linux" ? platform : null;
}

async function status(ctx: ServiceContext, platform: ServicePlatform, json: boolean, io: Io) {
  const s = await readStatus(ctx, platform);
  io.out(json ? statusJson(s) : statusLines(s).join("\n"));
  return s.installed && s.state?.running === true ? EXIT.ok : EXIT.failed;
}

async function change(ctx: ServiceContext, platform: ServicePlatform, a: ServiceArgs, io: Io) {
  const plan =
    a.action === "install" ? planInstall(ctx, platform) : ok(planUninstall(ctx, platform));
  if (!plan.ok) {
    if (a.json)
      io.out(
        JSON.stringify({ schema: SERVICE_SCHEMA, action: a.action, ok: false, error: plan.error }),
      );
    io.err(`cops service ${a.action}: ${plan.error}`);
    return EXIT.failed;
  }
  const report = await applyPlan(plan.value, ctx, runBlocker(ctx, platform, a.dryRun));
  io.out(a.json ? applyJson(plan.value, report) : applyLines(plan.value, report).join("\n"));
  if (report.error === null) return EXIT.ok;
  io.err(`cops service ${a.action}: ${report.error}`);
  if (a.action === "install" && !a.json) {
    io.err(statusLines(await readStatus(ctx, platform)).join("\n"));
  }
  return EXIT.failed;
}

/** Runs `cops service`; resolves with the exit code. */
export async function runServiceCommand(
  argv: readonly string[],
  io: Io,
  makeContext: ServiceContextFactory = processServiceContext,
): Promise<number> {
  const parsed = parseServiceArgs(argv);
  if (!parsed.ok) {
    io.err(`cops service: ${parsed.error}\n\nUsage:\n${SERVICE_USAGE}`);
    return EXIT.usage;
  }
  const a = parsed.value;
  const ctx = makeContext(a.home);
  const platform = a.platform ?? hostPlatform(ctx.platform);
  if (platform === null) {
    io.err(
      `cops service: ${ctx.platform} has no supported service manager (launchd on macOS, systemd --user on Linux); pass --platform darwin|linux to render a unit for one`,
    );
    return EXIT.usage;
  }
  return a.action === "status" ? status(ctx, platform, a.json, io) : change(ctx, platform, a, io);
}
