/**
 * What `cops service` prints: a few aligned lines for a human (every command copy-pastable),
 * or one `jev-cops.service/1` JSON document with `--json`.
 */
import { dirname } from "node:path";
import type { ApplyReport, FileOutcome, StepResult } from "../service/apply.ts";
import type { ServicePlan } from "../service/plan.ts";
import type { ServiceStatus } from "../service/status.ts";
import { commandLine } from "../service/text.ts";
import {
  type ManagerState,
  SERVICE_LABEL,
  type ServiceManager,
  SYSTEMD_UNIT,
} from "../service/units.ts";

/** The JSON schema name of `cops service --json`. */
export const SERVICE_SCHEMA = "jev-cops.service/1";

const row = (label: string, value: string) => `  ${label.padEnd(8)} ${value}`;

/** "launchd user agent dev.jev-cops.copsd" / "systemd --user unit copsd.service". */
export function managerTitle(manager: ServiceManager): string {
  return manager === "launchd"
    ? `launchd user agent ${SERVICE_LABEL}`
    : `systemd --user unit ${SYSTEMD_UNIT}`;
}

function fileWord(plan: ServicePlan, file: FileOutcome): string {
  if (file !== null) return file === "absent" ? "not installed" : file;
  if (plan.action === "install")
    return plan.previous === plan.content ? "unchanged" : "would write";
  return plan.previous === null ? "not installed" : "would remove";
}

function stepLine(s: StepResult): string {
  const code = s.code === null ? "no exit" : `exit ${s.code}`;
  const note = s.ok && s.code !== 0 ? ", not loaded: fine" : "";
  return row("ran", `${commandLine(s.argv)} (${code}${note})`);
}

function plannedLines(plan: ServicePlan, report: ApplyReport): string[] {
  if (report.notRun === null) return report.steps.map(stepLine);
  const planned = [...plan.before, ...plan.after];
  if (planned.length === 0) return [];
  return [
    row("not run", `${report.notRun}; the commands are:`),
    ...planned.map((s) => `    ${commandLine(s.argv)}`),
  ];
}

function unitPreview(plan: ServicePlan, report: ApplyReport): string[] {
  if (report.notRun !== "dry run" || plan.content === null || plan.previous === plan.content) {
    return [];
  }
  return [
    `  ${plan.unitPath} would hold:`,
    ...plan.content
      .trimEnd()
      .split("\n")
      .map((l) => `    ${l}`),
  ];
}

/** The human report of an install or uninstall (stdout lines). */
export function applyLines(plan: ServicePlan, report: ApplyReport): string[] {
  const program =
    plan.program === null
      ? []
      : [row("program", `${commandLine(plan.program.program)} (${plan.program.install})`)];
  const kept =
    plan.action === "uninstall" && report.error === null
      ? [row("kept", `${plan.logPath} and the rest of ${dirname(plan.logPath)}`)]
      : [];
  return [
    `cops service ${plan.action}: ${managerTitle(plan.manager)}`,
    ...program,
    row("unit", `${plan.unitPath} (${fileWord(plan, report.file)})`),
    ...(plan.action === "install" ? [row("log", plan.logPath)] : []),
    ...plannedLines(plan, report),
    ...(report.health === null ? [] : [row("health", report.health.detail)]),
    ...kept,
    ...unitPreview(plan, report),
    ...(report.notRun === "dry run" ? ["dry run: nothing written, nothing run"] : []),
  ];
}

function stateWord(state: ManagerState | null, notQueried: string | null): string {
  if (state === null) return `not queried: ${notQueried ?? "unknown"}`;
  if (state.running) return `running${state.pid === null ? "" : `, pid ${state.pid}`}`;
  if (!state.loaded) return "not loaded";
  return `loaded, not running${state.lastExit === null ? "" : ` (last exit ${state.lastExit})`}`;
}

function unitWord(s: ServiceStatus): string {
  if (!s.installed) return "not installed";
  if (s.upToDate === false) return "installed, differs from what `cops service install` writes now";
  return s.upToDate === true ? "installed, up to date" : "installed";
}

/** The human report of `status` (stdout lines). */
export function statusLines(s: ServiceStatus): string[] {
  const program =
    s.expected === null
      ? `cannot resolve: ${s.expectedProblem ?? "unknown"}`
      : `${commandLine(s.expected.program)} (${s.expected.install})`;
  const tail = s.logTail.length === 0 ? [] : s.logTail.map((l) => `    ${l}`);
  return [
    `copsd service (${managerTitle(s.manager)}): ${stateWord(s.state, s.notQueried)}`,
    row("unit", `${s.unitPath} (${unitWord(s)})`),
    row("program", program),
    row("state", stateWord(s.state, s.notQueried)),
    row(
      "log",
      `${s.logPath}${tail.length === 0 ? " (empty or absent)" : ` (last ${tail.length} lines)`}`,
    ),
    ...tail,
  ];
}

/** `--json` for an install or uninstall. */
export function applyJson(plan: ServicePlan, report: ApplyReport): string {
  return JSON.stringify({
    schema: SERVICE_SCHEMA,
    action: plan.action,
    platform: plan.platform,
    manager: plan.manager,
    unit: plan.unitPath,
    log: plan.logPath,
    program: plan.program?.program ?? null,
    install: plan.program?.install ?? null,
    file: report.file,
    planned: [...plan.before, ...plan.after].map((s) => s.argv),
    steps: report.steps,
    notRun: report.notRun,
    health: report.health,
    ok: report.error === null,
    error: report.error,
  });
}

/** `--json` for `status`; `ok` is true only when the service is verifiably running. */
export function statusJson(s: ServiceStatus): string {
  return JSON.stringify({
    schema: SERVICE_SCHEMA,
    action: "status",
    platform: s.platform,
    manager: s.manager,
    unit: s.unitPath,
    log: s.logPath,
    installed: s.installed,
    upToDate: s.upToDate,
    program: s.expected?.program ?? null,
    programProblem: s.expectedProblem,
    state: s.state,
    notQueried: s.notQueried,
    logTail: s.logTail,
    ok: s.installed && s.state?.running === true,
  });
}
