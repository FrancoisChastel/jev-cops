/**
 * copsd as a launchd user agent (`launchd.plist(5)`): `RunAtLoad`, restarted when it exits
 * non-zero (`KeepAlive.SuccessfulExit = false`) at most every 10 s, SIGTERM then SIGKILL
 * after 10 s, `ProcessType Background`, logs in `~/.jev-cops/copsd.log`. Loaded with
 * `launchctl bootstrap gui/<uid>` and removed with `bootout`; the deprecated
 * `load`/`unload` are never used.
 */
import { err, ok, type Result } from "@jev-cops/core";
import { type ManagerState, SERVICE_LABEL, type ServiceSpec, type Step } from "./units.ts";

/** `launchctl bootout` of a job that is not loaded: ESRCH (3) or "Could not find service" (113). */
const NOT_LOADED = [3, 113];

const XML: Readonly<Record<string, string>> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&apos;",
};

function xml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => XML[c] ?? c);
}

function controlProblem(spec: ServiceSpec): string | null {
  const values = [...spec.program, spec.home, spec.pathEnv, spec.logPath];
  const bad = values.find((v) => /\p{Cc}/u.test(v));
  return bad === undefined
    ? null
    : `cannot write ${JSON.stringify(bad)} into a launchd plist (control character)`;
}

/** The plist, or why a value cannot be written into one. */
export function renderLaunchdPlist(spec: ServiceSpec): Result<string, string> {
  const problem = controlProblem(spec);
  if (problem !== null) return err(problem);
  const s = (v: string) => `<string>${xml(v)}</string>`;
  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    "<dict>",
    ...["  <key>Label</key>", `  ${s(SERVICE_LABEL)}`],
    ...["  <key>ProgramArguments</key>", "  <array>"],
    ...spec.program.map((arg) => `    ${s(arg)}`),
    ...["  </array>", "  <key>EnvironmentVariables</key>", "  <dict>"],
    ...[
      "    <key>HOME</key>",
      `    ${s(spec.home)}`,
      "    <key>PATH</key>",
      `    ${s(spec.pathEnv)}`,
    ],
    ...["  </dict>", "  <key>WorkingDirectory</key>", `  ${s(spec.home)}`],
    ...["  <key>RunAtLoad</key>", "  <true/>"],
    ...[
      "  <key>KeepAlive</key>",
      "  <dict>",
      "    <key>SuccessfulExit</key>",
      "    <false/>",
      "  </dict>",
    ],
    ...["  <key>ThrottleInterval</key>", "  <integer>10</integer>"],
    ...["  <key>ExitTimeOut</key>", "  <integer>10</integer>"],
    ...["  <key>ProcessType</key>", "  <string>Background</string>"],
    ...["  <key>StandardOutPath</key>", `  ${s(spec.logPath)}`],
    ...["  <key>StandardErrorPath</key>", `  ${s(spec.logPath)}`],
    "</dict>",
    "</plist>",
    "",
  ];
  return ok(lines.join("\n"));
}

const target = (uid: number) => `gui/${uid}/${SERVICE_LABEL}`;

/** `bootstrap gui/<uid> <plist>`, after a tolerated `bootout` when a plist was already there. */
export function launchdInstallSteps(
  launchctl: string,
  uid: number,
  plist: string,
  replacing: boolean,
): Step[] {
  const bootstrap: Step = { argv: [launchctl, "bootstrap", `gui/${uid}`, plist], ok: [0] };
  return replacing ? [...launchdUninstallSteps(launchctl, uid), bootstrap] : [bootstrap];
}

/** `bootout gui/<uid>/<label>`; a job that is not loaded counts as booted out. */
export function launchdUninstallSteps(launchctl: string, uid: number): Step[] {
  return [{ argv: [launchctl, "bootout", target(uid)], ok: [0, ...NOT_LOADED] }];
}

/** `print gui/<uid>/<label>`: reads the job's state, changes nothing. */
export function launchdStatusStep(launchctl: string, uid: number): Step {
  return { argv: [launchctl, "print", target(uid)], ok: [0] };
}

/** The job's state from `launchctl print` (exit non-zero: not loaded). */
export function parseLaunchctlPrint(code: number | null, stdout: string): ManagerState {
  if (code !== 0) return { loaded: false, running: false, pid: null, lastExit: null };
  const field = (name: string) =>
    new RegExp(`^\\s*${name} = (.+)$`, "m").exec(stdout)?.[1]?.trim() ?? null;
  const pid = Number(field("pid"));
  return {
    loaded: true,
    running: field("state") === "running",
    pid: Number.isInteger(pid) && pid > 0 ? pid : null,
    lastExit: field("last exit code"),
  };
}
