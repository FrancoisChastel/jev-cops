/**
 * `cops install claude-code` (PLAN-M1 §3 step 6): resolve the daemon config and the hook
 * binary, refuse a binary that is missing, not executable or of another version (§5 row 1),
 * write the settings (adapter install.ts), record `[daemon] hook_binary` in cops.toml and
 * the state file, then run the offline canary through the hook exactly as registered and
 * roll every write back when it answers wrongly. A daemon that is down is a warning: the
 * hook fails closed until copsd runs.
 */

import { resolve } from "node:path";
import {
  type CanaryResult,
  claudeCodeStatePath,
  claudeVersion,
  defaultHookBinary,
  hookBinaryProblem,
  hookBinaryVersion,
  type InstallResult,
  installClaudeCodeHooks,
  isRootLocked,
  readSettingsFile,
  registeredPreToolUse,
  restoreSettings,
  restoreText,
  runOfflineCanary,
  uninstallClaudeCodeHooks,
  writeClaudeCodeState,
} from "@jev-cops/adapter-claude-code";
import { CLI_VERSION } from "../version.ts";
import type { ClaudeInstallArgs } from "./install-args.ts";
import type { InstallContext } from "./install-context.ts";
import { type ClaudeReport, emptyReport } from "./install-report.ts";
import {
  plannedHookBinaryToml,
  type Setup,
  settingsOptions,
  writeHookBinaryToml,
} from "./install-setup.ts";

type Checked = { readonly hookBinary: string; readonly error: null } | { readonly error: string };

/** The hook binary to register: given or default, present, executable, same version. */
export async function checkHookBinary(
  a: ClaudeInstallArgs,
  s: Setup,
  ctx: InstallContext,
): Promise<Checked> {
  const path =
    a.hookBinary === null
      ? defaultHookBinary(ctx.runtime, s.env.PATH ?? "")
      : resolve(ctx.cwd, a.hookBinary);
  if (path === null) {
    return {
      error:
        "no cops-hook found next to cops or on PATH: build it (bun run build:hook) or pass --hook-binary",
    };
  }
  const problem = hookBinaryProblem(path);
  if (problem !== null) return { error: problem };
  const env = { PATH: s.env.PATH ?? "", HOME: s.home };
  const { version, error } = await hookBinaryVersion(path, ctx.spawn, env);
  if (version !== CLI_VERSION) {
    const got = version ?? `no version (${error ?? "unknown"})`;
    return {
      error: `${path} --version is ${got}, not ${CLI_VERSION}: install the cops-hook built with this cops`,
    };
  }
  return { hookBinary: path, error: null };
}

function failedCanary(detail: string): CanaryResult {
  return { status: "failed", detail, probes: [] };
}

/** The canary through the PreToolUse entry as it now stands in the settings file. */
async function canaryOf(
  settings: InstallResult,
  hookBinary: string,
  s: Setup,
  ctx: InstallContext,
) {
  const read = readSettingsFile(settings.path);
  const hook = read.kind === "ok" ? registeredPreToolUse(read.value, hookBinary) : null;
  if (hook === null) {
    return failedCanary(`no jev-cops PreToolUse entry in ${settings.path} after the write`);
  }
  return runOfflineCanary({
    hook,
    home: s.home,
    env: { PATH: s.env.PATH ?? "" },
    spawn: ctx.spawn,
  });
}

interface Written {
  readonly toml: {
    readonly path: string;
    readonly previous: string | null;
    readonly changed: boolean;
  };
  readonly state: { readonly path: string; readonly previous: string | null };
  readonly claudeVersion: string | null;
}

async function recordInstall(
  settings: InstallResult,
  hookBinary: string,
  s: Setup,
  ctx: InstallContext,
): Promise<Written> {
  const now = ctx.now();
  const toml = writeHookBinaryToml(s, hookBinary, ctx); // throws before writing, or wrote it
  const claudeEnv = {
    PATH: s.env.PATH ?? "",
    HOME: s.home,
    ...(s.configDir === null ? {} : { CLAUDE_CONFIG_DIR: s.configDir }),
  };
  const version = await claudeVersion(ctx.spawn, claudeEnv);
  const record = {
    claude_version: version,
    installed_at: now.toISOString(),
    scope: settings.scope,
    settings_path: settings.path,
    hook_binary: hookBinary,
    socket: s.socket,
  };
  try {
    const state = writeClaudeCodeState(s.home, record, { fs: ctx.fs, now });
    return { toml, state, claudeVersion: version };
  } catch (cause) {
    if (toml.changed) restoreText(toml.path, toml.previous, 0o600, { fs: ctx.fs, now });
    throw cause;
  }
}

function rollback(settings: InstallResult, w: Written, ctx: InstallContext): void {
  const c = { fs: ctx.fs, now: ctx.now() };
  restoreSettings(settings, { fs: ctx.fs, now: ctx.now });
  if (w.toml.changed) restoreText(w.toml.path, w.toml.previous, 0o600, c);
  restoreText(w.state.path, w.state.previous, 0o600, c);
}

function managedWarnings(a: ClaudeInstallArgs, hookBinary: string): string[] {
  if (a.scope !== "managed" || isRootLocked(hookBinary)) return [];
  return [
    `${hookBinary} is not root-owned and locked (no group/world write): the agent could replace the hook a managed install runs; install cops-hook root-owned, e.g. under /usr/local/libexec/jev-cops/`,
  ];
}

/** After the settings are written: cops.toml, state, canary, rollback on a wrong answer. */
async function finish(
  base: ClaudeReport,
  settings: InstallResult,
  hookBinary: string,
  s: Setup,
  ctx: InstallContext,
): Promise<ClaudeReport> {
  let written: Written;
  try {
    written = await recordInstall(settings, hookBinary, s, ctx);
  } catch (cause) {
    restoreSettings(settings, { fs: ctx.fs, now: ctx.now });
    const why = cause instanceof Error ? cause.message : String(cause);
    return { ...base, ok: false, rolledBack: settings.written, errors: [...base.errors, why] };
  }
  const canary = await canaryOf(settings, hookBinary, s, ctx);
  const common = {
    ...base,
    configPath: written.toml.path,
    configChanged: written.toml.changed,
    statePath: written.state.path,
    claudeVersion: written.claudeVersion,
    canary,
  };
  if (canary.status !== "failed") return { ...common, ok: true };
  rollback(settings, written, ctx);
  return { ...common, ok: false, rolledBack: true, errors: [...common.errors, canary.detail] };
}

/** Runs the install; never throws for expected failures (they are in the report). */
export async function installClaudeCode(
  a: ClaudeInstallArgs,
  s: Setup,
  ctx: InstallContext,
): Promise<ClaudeReport> {
  const base = emptyReport("install", a, s);
  const checked = await checkHookBinary(a, s, ctx);
  if (checked.error !== null) return { ...base, errors: [checked.error] };
  const hookBinary = checked.hookBinary;
  const withBinary = {
    ...base,
    hookBinary,
    hookVersion: CLI_VERSION,
    warnings: [...base.warnings, ...managedWarnings(a, hookBinary)],
  };
  const settings = installClaudeCodeHooks(settingsOptions(a, s, ctx, hookBinary));
  const report = { ...withBinary, settings };
  if (settings.status === "refused" || settings.status === "printed") return report;
  if (settings.status === "dry-run") {
    const toml = plannedHookBinaryToml(s, hookBinary, ctx);
    const warnings = toml.problem === null ? report.warnings : [...report.warnings, toml.problem];
    const statePath = claudeCodeStatePath(s.home);
    const planned = { configPath: s.configPath, configChanged: toml.changed, statePath };
    return { ...report, ...planned, ok: toml.problem === null, warnings };
  }
  return finish(report, settings, hookBinary, s, ctx);
}

/** Removes the state file when it describes the settings file just cleaned. */
function forgetState(settingsPath: string, s: Setup, ctx: InstallContext): string | null {
  const path = claudeCodeStatePath(s.home);
  const text = ctx.fs.readFile(path);
  if (text === null) return null;
  try {
    const recorded = (JSON.parse(text) as { settings_path?: unknown }).settings_path;
    if (recorded !== settingsPath) return null;
  } catch {
    return null; // not ours to judge: leave an unreadable state file alone
  }
  restoreText(path, null, 0o600, { fs: ctx.fs, now: ctx.now() });
  return path;
}

/** `--uninstall`: only jev-cops's entries go; the state file too when it names that file. */
export function uninstallClaudeCode(
  a: ClaudeInstallArgs,
  s: Setup,
  ctx: InstallContext,
  hookBinary: string | null,
): ClaudeReport {
  const base = emptyReport("uninstall", a, s);
  const { hookBinary: _unused, ...where } = settingsOptions(a, s, ctx, "");
  const settings = uninstallClaudeCodeHooks(hookBinary === null ? where : { ...where, hookBinary });
  if (settings.status === "printed") return { ...base, settings };
  const statePath = settings.written ? forgetState(settings.path, s, ctx) : null;
  return { ...base, ok: true, settings, statePath };
}
