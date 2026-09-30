/**
 * `cops service <action> [options]` argument parsing: strict (an unknown option is a usage
 * error, exit 2), exactly one action.
 */
import { parseArgs } from "node:util";
import { err, ok, type Result } from "@jev-cops/core";
import type { ServicePlatform } from "../service/units.ts";

/** The actions of `cops service`. */
export const SERVICE_ACTIONS = ["install", "uninstall", "status"] as const;
export type ServiceAction = (typeof SERVICE_ACTIONS)[number];

/** Parsed `cops service` arguments. */
export interface ServiceArgs {
  readonly action: ServiceAction;
  /** `--home`: where the unit and `~/.jev-cops/` go (default: the real home). */
  readonly home: string | null;
  /** `--platform`: render for another platform than this machine's (nothing is run then). */
  readonly platform: ServicePlatform | null;
  readonly dryRun: boolean;
  readonly json: boolean;
}

const OPTIONS = {
  home: { type: "string" },
  platform: { type: "string" },
  "dry-run": { type: "boolean" },
  json: { type: "boolean" },
} as const;

function platformOf(value: string | undefined): Result<ServicePlatform | null, string> {
  if (value === undefined) return ok(null);
  if (value === "darwin" || value === "linux") return ok(value);
  return err(`--platform must be darwin or linux, got "${value}"`);
}

/** Parses `argv` (after `service`). */
export function parseServiceArgs(argv: readonly string[]): Result<ServiceArgs, string> {
  let parsed: ReturnType<typeof parseArgs<{ options: typeof OPTIONS; allowPositionals: true }>>;
  try {
    parsed = parseArgs({ args: [...argv], options: OPTIONS, allowPositionals: true, strict: true });
  } catch (cause) {
    return err((cause as Error).message);
  }
  const [action, ...extra] = parsed.positionals;
  if (action === undefined || !(SERVICE_ACTIONS as readonly string[]).includes(action)) {
    return err(`expected one of ${SERVICE_ACTIONS.join(", ")}, got ${action ?? "nothing"}`);
  }
  if (extra.length > 0) return err(`unexpected argument: ${extra[0]}`);
  const platform = platformOf(parsed.values.platform);
  if (!platform.ok) return platform;
  const dryRun = parsed.values["dry-run"] === true;
  if (dryRun && action === "status") return err("--dry-run is for install and uninstall");
  const home = parsed.values.home ?? null;
  if (home === "") return err("--home needs a directory");
  return ok({
    action: action as ServiceAction,
    home,
    platform: platform.value,
    dryRun,
    json: parsed.values.json === true,
  });
}
