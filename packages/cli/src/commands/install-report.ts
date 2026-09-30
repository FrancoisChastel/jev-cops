/**
 * What `cops install claude-code` reports, as lines for a human or one JSON object
 * (`--json`), and the exit code: 0 when installed (or already, or removed, or a dry run),
 * 1 when refused, not written (managed without root) or failed.
 */
import type {
  CanaryResult,
  InstallResult,
  InstallScope,
  Transport,
} from "@jev-cops/adapter-claude-code";
import { EXIT, type Io } from "../io.ts";
import type { ClaudeInstallArgs } from "./install-args.ts";
import type { Setup } from "./install-setup.ts";

/** One run's outcome. */
export interface ClaudeReport {
  readonly harness: "claude-code";
  readonly action: "install" | "uninstall";
  readonly ok: boolean;
  readonly dryRun: boolean;
  readonly scope: InstallScope;
  readonly transport: Transport;
  readonly settings: InstallResult | null;
  readonly hookBinary: string | null;
  readonly hookVersion: string | null;
  readonly socket: string | null;
  readonly enforcement: "observe" | "enforce" | null;
  readonly configPath: string | null;
  readonly configChanged: boolean;
  readonly statePath: string | null;
  readonly claudeVersion: string | null;
  readonly canary: CanaryResult | null;
  readonly rolledBack: boolean;
  readonly warnings: readonly string[];
  readonly errors: readonly string[];
}

/** A report with nothing done yet. */
export function emptyReport(
  action: ClaudeReport["action"],
  a: ClaudeInstallArgs,
  s: Setup | null,
): ClaudeReport {
  return {
    harness: "claude-code",
    action,
    ok: false,
    dryRun: a.dryRun,
    scope: a.scope,
    transport: a.transport,
    settings: null,
    hookBinary: null,
    hookVersion: null,
    socket: s?.socket ?? null,
    enforcement: s?.enforcement ?? null,
    configPath: null,
    configChanged: false,
    statePath: null,
    claudeVersion: null,
    canary: null,
    rolledBack: false,
    warnings: s?.warnings ?? [],
    errors: [],
  };
}

/** 0 on success, 1 otherwise. */
export function exitCodeOf(r: ClaudeReport): number {
  return r.ok ? EXIT.ok : EXIT.failed;
}

const TAG = "jev-cops:";

function settingsLines(r: InstallResult): string[] {
  switch (r.status) {
    case "installed":
      return [
        `${TAG} Claude Code hooks installed in ${r.path} (${r.scope} scope)`,
        ...(r.backup === null ? [] : [`${TAG} previous file backed up to ${r.backup}`]),
      ];
    case "unchanged":
      return [`${TAG} Claude Code hooks already installed in ${r.path} (${r.scope} scope)`];
    case "dry-run":
      return [
        `${TAG} dry run, nothing written; ${r.path} would change:`,
        r.diff || "  (no change)",
      ];
    case "refused":
      return [
        `${TAG} refused to install into ${r.path}:`,
        ...r.refused.map((f) => `  - ${f}`),
        `${TAG} fix these, or pass --force to install anyway (the gap is then recorded as yours)`,
      ];
    case "printed":
      return [
        `${TAG} not root: ${r.path} was not written (cops never runs sudo). As root, write it with mode 0644, or rerun this install as root:`,
        r.after ?? "",
      ];
    case "uninstalled":
      return [
        `${TAG} jev-cops hooks removed from ${r.path}${r.after === null ? " (file left empty: removed)" : ""}`,
        ...(r.backup === null ? [] : [`${TAG} previous file backed up to ${r.backup}`]),
      ];
    case "absent":
      return [`${TAG} no jev-cops hooks in ${r.path}`];
  }
}

function installLines(r: ClaudeReport): string[] {
  if (r.action !== "install" || r.hookBinary === null) return [];
  const lines = [
    `${TAG} hook ${r.hookBinary} (version ${r.hookVersion ?? "?"}), socket ${r.socket ?? "?"}, transport ${r.transport}`,
  ];
  if (r.configPath !== null) {
    const verb = !r.configChanged ? "already recorded" : r.dryRun ? "would record" : "recorded";
    lines.push(
      `${TAG} ${verb} [daemon] hook_binary in ${r.configPath} (copsd protects it from its next start)`,
    );
  }
  if (r.statePath !== null) {
    const claude =
      r.claudeVersion === null
        ? "claude not found on PATH: harness_version omitted"
        : `Claude Code ${r.claudeVersion}`;
    lines.push(
      `${TAG} ${r.dryRun ? "would write" : "wrote"} ${r.statePath}${r.dryRun ? "" : ` (${claude})`}`,
    );
  }
  return lines;
}

function uninstallLines(r: ClaudeReport): string[] {
  if (r.action !== "uninstall" || !r.configChanged || r.configPath === null) return [];
  return [
    `${TAG} ${r.dryRun ? "would remove" : "removed"} [daemon] hook_binary from ${r.configPath}`,
  ];
}

function canaryLines(r: ClaudeReport): string[] {
  const c = r.canary;
  if (c === null) return [];
  if (c.status === "unreachable") return [`${TAG} warning: ${c.detail}`];
  const lines = [`${TAG} canary ${c.status}: ${c.detail}`];
  if (r.rolledBack)
    lines.push(`${TAG} rolled back: the settings, cops.toml and state are as they were`);
  return lines;
}

/**
 * The report for `--json`: the settings file's text is left out (settings can hold
 * secrets in `env`), except the diff of a dry run and the content of a printed drop-in.
 */
function jsonOf(r: ClaudeReport): Record<string, unknown> {
  if (r.settings === null) return { ...r, exitCode: exitCodeOf(r) };
  const { before: _before, after, diff, ...settings } = r.settings;
  const shown = {
    ...settings,
    ...(r.settings.status === "printed" ? { after } : {}),
    ...(r.settings.status === "dry-run" ? { diff } : {}),
  };
  return { ...r, settings: shown, exitCode: exitCodeOf(r) };
}

/** The report as lines (warnings and gaps included) or as one JSON object. */
export function printClaudeReport(r: ClaudeReport, io: Io, json: boolean): void {
  if (json) {
    io.out(JSON.stringify(jsonOf(r)));
    return;
  }
  for (const e of r.errors) io.err(`${TAG} error: ${e}`);
  const lines = [
    ...(r.settings === null ? [] : settingsLines(r.settings)),
    ...installLines(r),
    ...uninstallLines(r),
    ...canaryLines(r),
    ...[...r.warnings, ...(r.settings?.warnings ?? [])].map((w) => `${TAG} warning: ${w}`),
  ];
  for (const l of lines) io.out(l);
  if (r.settings === null) return;
  io.out(`${TAG} known gaps (docs/adapters.md#claude-code):`);
  for (const g of r.settings.gaps) io.out(`  - ${g}`);
}
