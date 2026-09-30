/**
 * Everything `cops service` reads from the process, in one injected value: the home to write
 * under, the real home (commands run only when they are the same), the platform and uid, how
 * `cops` was started, the service-manager runner, the health probe and where the daemon
 * package is. {@link processServiceContext} is the only place the real ones are read; tests
 * build their own, so no test ever loads a real launchd or systemd unit.
 */
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { type CliRuntime, spawnProcess } from "@jev-cops/adapter-claude-code";
import { loadConfig } from "@jev-cops/daemon";

/** What one service-manager command returned; `code` is null when it did not run to an exit. */
export interface RunResult {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

/** Runs one command in exec form (absolute argv[0]). */
export type ServiceRunner = (argv: readonly string[]) => Promise<RunResult>;

/** Whether copsd answers, with a line saying where or why not. */
export interface HealthResult {
  readonly ok: boolean;
  readonly detail: string;
}

/** Waits up to `timeoutMs` for the copsd configured under `home` to answer `/v1/health`. */
export type HealthCheck = (home: string, timeoutMs: number) => Promise<HealthResult>;

/** The process as `cops service` sees it. */
export interface ServiceContext {
  /** `--home`, else the real home: where the unit and the log directory go. */
  readonly home: string;
  /** `os.homedir()`: service-manager commands run only when `home` is this. */
  readonly realHome: string;
  readonly platform: NodeJS.Platform;
  readonly uid: number;
  readonly runtime: CliRuntime;
  readonly run: ServiceRunner;
  readonly health: HealthCheck;
  /** The installed `@jev-cops/daemon` entry (npm path), or null. */
  readonly resolveDaemonEntry: () => string | null;
  readonly launchctl: string;
  readonly systemctl: string;
}

/** How long `install` waits for the new copsd to answer. */
export const HEALTH_TIMEOUT_MS = 10_000;
const HEALTH_POLL_MS = 250;
const PROBE_TIMEOUT_MS = 1_000;
const RUN_TIMEOUT_MS = 15_000;

/**
 * The real runner: exec form, a fixed system `PATH`, and only what `systemctl --user` needs
 * to reach the user manager (`XDG_RUNTIME_DIR`, `DBUS_SESSION_BUS_ADDRESS`).
 */
export function processRunner(
  home: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
): ServiceRunner {
  const passed = ["XDG_RUNTIME_DIR", "DBUS_SESSION_BUS_ADDRESS", "LANG"].flatMap((k) => {
    const v = env[k];
    return v === undefined || v === "" ? [] : [[k, v] as const];
  });
  const runEnv = {
    PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
    HOME: home,
    ...Object.fromEntries(passed),
  };
  return async (argv) => {
    const r = await spawnProcess({ argv, env: runEnv, timeoutMs: RUN_TIMEOUT_MS });
    const stderr = r.error === null ? r.stderr : `${r.stderr}${r.error}`;
    return { code: r.exitCode, stdout: r.stdout, stderr };
  };
}

async function answers(socket: string): Promise<boolean> {
  try {
    const res = await fetch("http://localhost/v1/health", {
      unix: socket,
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    return res.status === 200;
  } catch {
    return false;
  }
}

/**
 * The real health probe: both sockets of the config copsd loads under `home` (the service
 * runs there with no `$JEV_COPS_CONFIG`) must answer `/v1/health` 200 before the deadline.
 */
export const daemonHealth: HealthCheck = async (home, timeoutMs) => {
  let sockets: string[];
  try {
    const { config } = loadConfig({ home, cwd: home, env: {}, installedPolicies: null });
    sockets = [config.daemon.socket, config.daemon.adminSocket];
  } catch (cause) {
    return { ok: false, detail: `copsd cannot start: ${(cause as Error).message}` };
  }
  const deadline = Date.now() + timeoutMs;
  for (const socket of sockets) {
    while (!(await answers(socket))) {
      if (Date.now() >= deadline) {
        return { ok: false, detail: `no answer on ${socket} within ${timeoutMs} ms` };
      }
      await Bun.sleep(HEALTH_POLL_MS);
    }
  }
  return { ok: true, detail: `copsd answers /v1/health on ${sockets.join(" and ")}` };
};

/** The installed `@jev-cops/daemon` entry, resolved from this package (the npm path). */
export function installedDaemonEntry(): string | null {
  try {
    return Bun.resolveSync("@jev-cops/daemon/main", import.meta.dir);
  } catch {
    return null;
  }
}

function systemctlPath(): string {
  return (
    ["/usr/bin/systemctl", "/bin/systemctl"].find((p) => existsSync(p)) ?? "/usr/bin/systemctl"
  );
}

/** The real process; `home` is `--home` (resolved against the cwd), else the real home. */
export function processServiceContext(home: string | null = null): ServiceContext {
  const realHome = homedir();
  const target = home === null ? realHome : resolve(home);
  return {
    home: target,
    realHome,
    platform: process.platform,
    uid: typeof process.getuid === "function" ? process.getuid() : 0,
    runtime: { execPath: process.execPath, main: Bun.main },
    run: processRunner(realHome),
    health: daemonHealth,
    resolveDaemonEntry: installedDaemonEntry,
    launchctl: "/bin/launchctl",
    systemctl: systemctlPath(),
  };
}
