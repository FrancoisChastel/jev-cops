/**
 * What `copsd` as a login service needs whatever the service manager (PLAN-SETUP §7.3, S-11):
 * the names, the paths under the given home, an explicit `PATH` (launchd's default is only
 * `/usr/bin:/bin:/usr/sbin:/sbin`, and user services inherit no shell `PATH`), and the
 * daemon program as absolute paths: the `copsd` binary next to a compiled `cops`, or the
 * running `bun` plus the installed `@jev-cops/daemon` entry on the npm path.
 */
import { accessSync, constants, existsSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import type { CliRuntime } from "@jev-cops/adapter-claude-code";
import { err, ok, type Result } from "@jev-cops/core";

/** The launchd label (reverse-DNS of the project). */
export const SERVICE_LABEL = "dev.jev-cops.copsd";
/** The systemd user unit's name. */
export const SYSTEMD_UNIT = "copsd.service";
/** Where copsd's stdout and stderr go, under `~/.jev-cops/` (protected and private already). */
export const LOG_FILE = "copsd.log";

/** The platforms `cops service` renders units for. */
export type ServicePlatform = "darwin" | "linux";
/** launchd user agent on macOS, `systemd --user` on Linux. */
export type ServiceManager = "launchd" | "systemd";

/** Everything a unit file holds; every path absolute. */
export interface ServiceSpec {
  readonly program: readonly string[];
  readonly home: string;
  readonly pathEnv: string;
  readonly logPath: string;
}

/** One service-manager command and the exit codes that count as success. */
export interface Step {
  readonly argv: readonly string[];
  readonly ok: readonly number[];
}

/** What the service manager says about the job. */
export interface ManagerState {
  readonly loaded: boolean;
  readonly running: boolean;
  readonly pid: number | null;
  readonly lastExit: string | null;
}

/** The manager for a platform. */
export function managerOf(platform: ServicePlatform): ServiceManager {
  return platform === "darwin" ? "launchd" : "systemd";
}

/** The unit file: `~/Library/LaunchAgents/<label>.plist` or `~/.config/systemd/user/copsd.service`. */
export function unitPath(manager: ServiceManager, home: string): string {
  return manager === "launchd"
    ? join(home, "Library", "LaunchAgents", `${SERVICE_LABEL}.plist`)
    : join(home, ".config", "systemd", "user", SYSTEMD_UNIT);
}

/** `~/.jev-cops/copsd.log`. */
export function logPath(home: string): string {
  return join(home, ".jev-cops", LOG_FILE);
}

/**
 * The service's `PATH`: system directories first (so a tool planted in a user directory
 * never shadows `git`), then where `install.sh`, `uv tool` and Bun put binaries, then the
 * package managers' directories.
 */
export function servicePathEnv(platform: ServicePlatform, home: string): string {
  const user = [join(home, ".local", "bin"), join(home, ".bun", "bin")];
  const dirs =
    platform === "darwin"
      ? ["/usr/bin", "/bin", "/usr/sbin", "/sbin", ...user, "/opt/homebrew/bin", "/usr/local/bin"]
      : ["/usr/local/bin", "/usr/bin", "/bin", ...user];
  return dirs.join(":");
}

/** The spec of the unit for `program` on `platform` under `home`. */
export function serviceSpec(
  platform: ServicePlatform,
  home: string,
  program: readonly string[],
): ServiceSpec {
  return { program, home, pathEnv: servicePathEnv(platform, home), logPath: logPath(home) };
}

function isCompiled(main: string): boolean {
  return main.startsWith("/$bunfs/") || main.startsWith("B:/~BUN/");
}

function executableProblem(path: string): string | null {
  try {
    if (!statSync(path).isFile()) return `copsd at ${path} is not a file`;
  } catch {
    return `copsd not found next to cops (${path}): reinstall jev-cops`;
  }
  try {
    accessSync(path, constants.X_OK);
    return null;
  } catch {
    return `copsd at ${path} is not executable (chmod +x)`;
  }
}

/**
 * `execPath` as a stable path: a `bun` on `pathEnv` that is the same file (Homebrew's
 * `/opt/homebrew/bin/bun` → a versioned Cellar path that an upgrade removes), else as is.
 */
function stableBun(execPath: string, pathEnv: string): string {
  let real: string;
  try {
    real = realpathSync(execPath);
  } catch {
    return execPath;
  }
  for (const dir of pathEnv.split(":").filter((d) => isAbsolute(d))) {
    const candidate = join(dir, "bun");
    try {
      if (realpathSync(candidate) === real) return candidate;
    } catch {
      // Not there.
    }
  }
  return execPath;
}

/** How the daemon entry is found on the npm path, and the `PATH` a stable bun is looked for on. */
export interface ProgramDeps {
  readonly resolveEntry: () => string | null;
  readonly pathEnv: string;
}

/** The daemon program, and which install it comes from. */
export interface DaemonProgram {
  readonly program: readonly string[];
  readonly install: "compiled" | "package";
}

/**
 * The absolute argv that starts copsd: `<dir of cops>/copsd` for a compiled `cops`
 * (install.sh puts the three binaries in one directory), else `[bun, <@jev-cops/daemon
 * entry>]` with the running bun. Refused, never guessed, when either is missing.
 */
export function resolveDaemonProgram(
  runtime: CliRuntime,
  deps: ProgramDeps,
): Result<DaemonProgram, string> {
  if (isCompiled(runtime.main)) {
    const copsd = join(dirname(runtime.execPath), "copsd");
    const problem = executableProblem(copsd);
    return problem === null ? ok({ program: [copsd], install: "compiled" }) : err(problem);
  }
  const entry = deps.resolveEntry();
  if (entry === null) {
    return err("@jev-cops/daemon is not installed next to @jev-cops/cli: reinstall jev-cops");
  }
  if (!isAbsolute(entry) || !existsSync(entry)) {
    return err(`the daemon entry ${entry} does not exist`);
  }
  return ok({ program: [stableBun(runtime.execPath, deps.pathEnv), entry], install: "package" });
}
