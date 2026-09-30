/**
 * copsd as a `systemd --user` service (`systemd.service(5)`): `Restart=on-failure` after 2 s,
 * SIGTERM with a 10 s stop timeout, stdout and stderr appended to `~/.jev-cops/copsd.log`,
 * wanted by `default.target`. Every path is written literally (no `%h`), so the unit runs
 * exactly what `--home` named; a path systemd would reinterpret (whitespace, quotes,
 * backslash, `%` specifiers, `$` expansion, `;`) is refused rather than escaped.
 */
import { err, ok, type Result } from "@jev-cops/core";
import { type ManagerState, type ServiceSpec, type Step, SYSTEMD_UNIT } from "./units.ts";

const UNSAFE = /[\s"'\\%$;]|\p{Cc}/u;

function unsafeReason(value: string): string | null {
  const c = UNSAFE.exec(value)?.[0];
  if (c === undefined) return null;
  if (/\p{Cc}/u.test(c) && !/\s/.test(c)) return "control character";
  return /\s/.test(c) ? "whitespace" : c;
}

function unitProblem(spec: ServiceSpec): string | null {
  for (const value of [...spec.program, spec.home, spec.pathEnv, spec.logPath]) {
    const why = unsafeReason(value);
    if (why !== null) return `cannot write ${JSON.stringify(value)} into a systemd unit (${why})`;
  }
  return null;
}

/** The unit file, or why a value cannot be written into one. */
export function renderSystemdUnit(spec: ServiceSpec): Result<string, string> {
  const problem = unitProblem(spec);
  if (problem !== null) return err(problem);
  const lines = [
    "# Written by `cops service install`; `cops service uninstall` removes it.",
    "[Unit]",
    "Description=jev-cops judging daemon",
    "After=default.target",
    "",
    "[Service]",
    "Type=simple",
    `ExecStart=${spec.program.join(" ")}`,
    `Environment=HOME=${spec.home}`,
    `Environment=PATH=${spec.pathEnv}`,
    `WorkingDirectory=${spec.home}`,
    "Restart=on-failure",
    "RestartSec=2",
    "KillSignal=SIGTERM",
    "TimeoutStopSec=10",
    `StandardOutput=append:${spec.logPath}`,
    `StandardError=append:${spec.logPath}`,
    "",
    "[Install]",
    "WantedBy=default.target",
    "",
  ];
  return ok(lines.join("\n"));
}

const user = (systemctl: string, ...args: string[]): Step => ({
  argv: [systemctl, "--user", ...args],
  ok: [0],
});

/** `daemon-reload`, `enable --now`; a re-install also restarts it (a changed unit or binary). */
export function systemdInstallSteps(systemctl: string, replacing: boolean): Step[] {
  const base = [user(systemctl, "daemon-reload"), user(systemctl, "enable", "--now", SYSTEMD_UNIT)];
  return replacing ? [...base, user(systemctl, "restart", SYSTEMD_UNIT)] : base;
}

/** `disable --now` before the file is removed, `daemon-reload` after. */
export function systemdUninstallSteps(systemctl: string): { before: Step[]; after: Step[] } {
  return {
    before: [user(systemctl, "disable", "--now", SYSTEMD_UNIT)],
    after: [user(systemctl, "daemon-reload")],
  };
}

/** `show` with the properties the digest needs: reads, changes nothing. */
export function systemdStatusStep(systemctl: string): Step {
  return user(
    systemctl,
    "show",
    SYSTEMD_UNIT,
    "--property=LoadState,ActiveState,SubState,MainPID,ExecMainStatus",
  );
}

/** The unit's state from `systemctl --user show` (exit non-zero: unknown, counted as not loaded). */
export function parseSystemctlShow(code: number | null, stdout: string): ManagerState {
  const none: ManagerState = { loaded: false, running: false, pid: null, lastExit: null };
  if (code !== 0) return none;
  const props = new Map(
    stdout
      .split("\n")
      .filter((l) => l.includes("="))
      .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1).trim()]),
  );
  if (props.get("LoadState") !== "loaded") return none;
  const pid = Number(props.get("MainPID"));
  return {
    loaded: true,
    running: props.get("ActiveState") === "active" && props.get("SubState") === "running",
    pid: Number.isInteger(pid) && pid > 0 ? pid : null,
    lastExit: props.get("ExecMainStatus") ?? null,
  };
}
