/**
 * `cops install claude-code` (PLAN-M1 §3 step 6): resolve the daemon config and the hook
 * binary, refuse a binary that is missing, not executable or of another version (§5 row 1),
 * write the settings (adapter install.ts), record `[daemon] hook_binary` in cops.toml and
 * the state file, then run the offline canary through the hook exactly as registered (its
 * ConfigChange probe included: the hook must find itself in what was written) and roll
 * every write back when it answers wrongly. A daemon that is down is a warning: the
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
  isSharedWritable,
  managedDirFor,
  readSettingsFile,
  registeredPreToolUse,
  restoreSettings,
  restoreText,
  runOfflineCanary,
  settingsPathFor,
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
        "no cops-hook found next to cops, in its npm install or on PATH: install the jev-cops package, build it (bun run build:hook) or pass --hook-binary",
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
  const configDir = s.configDir === null ? {} : { CLAUDE_CONFIG_DIR: s.configDir };
  return runOfflineCanary({
    hook,
    home: s.home,
    env: { PATH: s.env.PATH ?? "", ...configDir },
    spawn: ctx.spawn,
    ...(hookSees(settings, s) ? { config: configProbe(s) } : {}),
  });
}

/**
 * The ConfigChange probe: a user-settings change that changes nothing must be accepted by the
 * hook's own intact check, run in the project whose settings it reads (the Docker e2e's F1).
 */
function configProbe(s: Setup) {
  return { filePath: settingsPathFor("user", s), projectDir: s.projectDir };
}

/**
 * Whether the hook will read the file just written: always, except a managed drop-in in a
 * directory other than this OS's managed-settings directory (tests), which the hook never reads.
 */
function hookSees(settings: InstallResult, s: Setup): boolean {
  return settings.scope !== "managed" || s.managedDir === managedDirFor(process.platform);
}

/** The per-user records an install wrote (null: not written, a managed install). */
interface Written {
  readonly toml: {
    readonly path: string;
    readonly previous: string | null;
    readonly changed: boolean;
  } | null;
  readonly state: { readonly path: string; readonly previous: string | null } | null;
  readonly claudeVersion: string | null;
}

/**
 * A managed install is an administrator's (often root's): it writes no cops.toml or state
 * file into a home directory, where root-owned files would lock the user's copsd out of its
 * own config. It says which line each user's cops.toml needs instead.
 */
const NOTHING_WRITTEN: Written = { toml: null, state: null, claudeVersion: null };

function managedNote(hookBinary: string): string {
  return `managed install: cops.toml and ~/.jev-cops/claude-code.json were not written; add [daemon] hook_binary = ${JSON.stringify(hookBinary)} to the cops.toml each copsd reads so it protects the binary`;
}

async function recordInstall(
  settings: InstallResult,
  hookBinary: string,
  s: Setup,
  ctx: InstallContext,
): Promise<Written> {
  const now = ctx.now();
  const toml = writeHookBinaryToml(s, hookBinary, ctx); // throws before writing, or wrote it
  try {
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
    const state = writeClaudeCodeState(s.home, record, { fs: ctx.fs, now });
    return { toml, state, claudeVersion: version };
  } catch (cause) {
    // Every step after the cops.toml write undoes it, so a failure never leaves it behind.
    if (toml.changed) restoreText(toml.path, toml.previous, 0o600, { fs: ctx.fs, now });
    throw cause;
  }
}

function rollback(settings: InstallResult, w: Written, ctx: InstallContext): void {
  const c = { fs: ctx.fs, now: ctx.now() };
  restoreSettings(settings, { fs: ctx.fs, now: ctx.now });
  if (w.toml?.changed === true) restoreText(w.toml.path, w.toml.previous, 0o600, c);
  if (w.state !== null) restoreText(w.state.path, w.state.previous, 0o600, c);
}

/** Hooks may not see `CLAUDE_CONFIG_DIR` (hooks#common-input-fields, env-vars, v2.1.251+). */
function configDirWarnings(s: Setup): string[] {
  if (s.configDir === null) return [];
  return [
    `CLAUDE_CONFIG_DIR is set (${s.configDir}): with CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1 Claude Code strips it from hook processes (v2.1.251+), so the ConfigChange check would look for the user settings in ~/.claude and block every settings change; do not combine the two`,
  ];
}

function managedWarnings(a: ClaudeInstallArgs, hookBinary: string): string[] {
  if (a.scope !== "managed" || isRootLocked(hookBinary)) return [];
  return [
    `${hookBinary} is not root-owned and locked (no group/world write): the agent could replace the hook a managed install runs; install cops-hook root-owned, e.g. under /usr/local/libexec/jev-cops/`,
  ];
}

/** A non-managed hook that other users may write (Bun installs package bins mode 0777). */
function sharedWritableWarnings(a: ClaudeInstallArgs, hookBinary: string): string[] {
  if (a.scope === "managed" || !isSharedWritable(hookBinary)) return [];
  return [
    `${hookBinary} is writable by other users (Bun installs package bins mode 0777): anyone on this machine could rewrite the hook; run \`chmod go-w ${hookBinary}\``,
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
  let written: Written = NOTHING_WRITTEN;
  try {
    if (settings.scope !== "managed") written = await recordInstall(settings, hookBinary, s, ctx);
  } catch (cause) {
    restoreSettings(settings, { fs: ctx.fs, now: ctx.now });
    const why = cause instanceof Error ? cause.message : String(cause);
    return { ...base, ok: false, rolledBack: settings.written, errors: [...base.errors, why] };
  }
  const canary = await canaryOf(settings, hookBinary, s, ctx);
  const note = settings.scope === "managed" ? [managedNote(hookBinary)] : [];
  const common = {
    ...base,
    configPath: written.toml?.path ?? null,
    configChanged: written.toml?.changed ?? false,
    statePath: written.state?.path ?? null,
    claudeVersion: written.claudeVersion,
    canary,
    warnings: [...base.warnings, ...note],
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
    warnings: [
      ...base.warnings,
      ...configDirWarnings(s),
      ...managedWarnings(a, hookBinary),
      ...sharedWritableWarnings(a, hookBinary),
    ],
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
