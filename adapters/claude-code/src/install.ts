/**
 * `cops install claude-code`, the settings half (PLAN-M1 §3 step 6, §4.3, D-075 proposal):
 * read every settings file Claude Code loads, refuse or warn (refusals.ts), merge the
 * jev-cops entries into the scope's file (settings-merge.ts), and write it atomically with
 * a backup (settings-io.ts). The hook binary, the daemon config, the state file and the
 * canary are the CLI's (packages/cli/src/commands/install-claude-code.ts). Home, project,
 * managed directory and file system are all injected: nothing here reads `os.homedir()`.
 */
import { CLAUDE_CODE_GAPS } from "./gaps.ts";
import { jevCopsHookEntries, type Transport } from "./hook-entries.ts";
import { checkIntact } from "./intact.ts";
import { lineDiff } from "./line-diff.ts";
import { type InstallCheck, installWarnings, refusals, type SettingsView } from "./refusals.ts";
import {
  globalConfigPaths,
  parseSettingsText,
  type SettingsFile,
  type SettingsLocation,
  type SettingsRead,
  settingsFiles,
  settingsPathFor,
} from "./settings.ts";
import {
  backupPath,
  type InstallFs,
  NODE_INSTALL_FS,
  removeFile,
  serializeSettings,
  writeFileAtomic,
} from "./settings-io.ts";
import { hooksShapeError, mergeHooks, stripJevCops } from "./settings-merge.ts";

/** Where the entries go: user (default), project, local, or a managed drop-in. */
export type InstallScope = SettingsFile["scope"];

/** Everything an install reads; the CLI resolves each value (see the module doc). */
export interface InstallOptions extends SettingsLocation {
  readonly scope: InstallScope;
  /** Absolute path of the hook binary to register (checked by the caller). */
  readonly hookBinary: string;
  /** The daemon's agent socket, absolute. */
  readonly socket: string;
  readonly transport: Transport;
  /** The daemon's loopback URL (`[daemon] http`), or null when it has none. */
  readonly httpUrl: string | null;
  /** Install despite refusals (each is kept as a `FORCED:` warning and in `forced`). */
  readonly force?: boolean;
  /** Compute and report, write nothing. */
  readonly dryRun?: boolean;
  /** Only root writes managed settings; otherwise the JSON is printed (never sudo). */
  readonly isRoot?: boolean;
  /** `PATH` for the post-install intact check (bare command names). */
  readonly pathEnv?: string;
  readonly fs?: InstallFs;
  readonly now?: () => Date;
}

/** What happened to the settings file. */
export type InstallStatus =
  | "installed"
  | "unchanged"
  | "refused"
  | "printed"
  | "dry-run"
  | "uninstalled"
  | "absent";

/** The outcome; `before`/`after` are the file's text (null: absent). */
export interface InstallResult {
  readonly scope: InstallScope;
  readonly path: string;
  readonly status: InstallStatus;
  readonly changed: boolean;
  readonly written: boolean;
  readonly backup: string | null;
  readonly before: string | null;
  readonly after: string | null;
  /** What would change / changed, for `--dry-run` (settings text, line diff). */
  readonly diff: string;
  readonly refused: readonly string[];
  readonly warnings: readonly string[];
  /** Refusals `--force` overrode: gaps the user accepted. */
  readonly forced: readonly string[];
  readonly gaps: readonly string[];
}

/** A target that cannot be read, merged into or written; carries the intended content. */
export class InstallError extends Error {
  override readonly name = "InstallError";
  constructor(
    message: string,
    readonly path: string,
    readonly content: string | null = null,
  ) {
    super(message);
  }
}

/** File mode and new-directory mode per scope: private for user/local, readable otherwise. */
const MODES: Readonly<Record<InstallScope, { file: number; dir: number }>> = {
  user: { file: 0o600, dir: 0o700 },
  local: { file: 0o600, dir: 0o755 },
  project: { file: 0o644, dir: 0o755 },
  managed: { file: 0o644, dir: 0o755 },
};

function message(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function readGlobal(loc: SettingsLocation, fs: InstallFs): SettingsRead {
  for (const path of globalConfigPaths(loc)) {
    const text = fs.readFile(path);
    if (text !== null) return parseSettingsText(text);
  }
  return { kind: "missing" };
}

function readOne(path: string, fs: InstallFs): SettingsRead {
  try {
    const text = fs.readFile(path);
    return text === null ? { kind: "missing" } : parseSettingsText(text);
  } catch (cause) {
    return { kind: "invalid", error: message(cause) };
  }
}

/** Every settings file Claude Code loads for `loc`, as read now, and `~/.claude.json`. */
export function readView(loc: SettingsLocation, fs: InstallFs = NODE_INSTALL_FS): SettingsView {
  const files = settingsFiles(loc).map((file) => ({ file, read: readOne(file.path, fs) }));
  return { files, globalConfig: readGlobal(loc, fs) };
}

/** The target's current text and settings object; invalid JSON is an {@link InstallError}. */
function readTarget(path: string, fs: InstallFs) {
  const before = fs.readFile(path);
  if (before === null) return { before, existing: {} };
  const parsed = parseSettingsText(before);
  if (parsed.kind !== "ok") {
    const why = parsed.kind === "invalid" ? parsed.error : "unreadable";
    throw new InstallError(`${path} is not a valid settings file (${why}); fix it first`, path);
  }
  const shape = hooksShapeError(parsed.value);
  if (shape !== null) throw new InstallError(`${path}: ${shape}; fix it first`, path);
  return { before, existing: parsed.value };
}

function intactWarning(
  o: InstallOptions,
  view: SettingsView,
  path: string,
  merged: Readonly<Record<string, unknown>>,
) {
  const planned = { file: { scope: o.scope, path }, read: { kind: "ok" as const, value: merged } };
  const reads = [...view.files.filter((f) => f.file.path !== path), planned];
  const id = {
    command: o.hookBinary,
    leading: [],
    socket: o.socket,
    home: o.home,
    projectDir: o.projectDir,
    path: o.pathEnv ?? "",
    httpUrl: o.transport === "http" ? o.httpUrl : null,
  };
  const check = checkIntact(reads, id);
  if (check.intact) return [];
  return [
    `after this install the ConfigChange check would not find the cops hook intact (${check.why}): every settings change in a session would be blocked and end the session`,
  ];
}

type Base = Pick<InstallResult, "scope" | "path" | "before" | "gaps">;

function result(base: Base, over: Partial<InstallResult> & Pick<InstallResult, "status">) {
  return {
    ...base,
    changed: false,
    written: false,
    backup: null,
    after: base.before,
    diff: "",
    refused: [],
    warnings: [],
    forced: [],
    ...over,
  } satisfies InstallResult;
}

function write(o: InstallOptions, path: string, text: string): string | null {
  const fs = o.fs ?? NODE_INSTALL_FS;
  const now = (o.now ?? (() => new Date()))();
  const { file, dir } = MODES[o.scope];
  try {
    return writeFileAtomic(path, text, { mode: file, dirMode: dir, now, fs }).backup;
  } catch (cause) {
    throw new InstallError(`cannot write ${path}: ${message(cause)}`, path, text);
  }
}

/** Refusals and warnings for this install; forced refusals become warnings. */
function assess(o: InstallOptions, view: SettingsView) {
  const fs = o.fs ?? NODE_INSTALL_FS;
  const check: InstallCheck = {
    scope: o.scope,
    transport: o.transport,
    httpUrl: o.httpUrl,
    projectDir: o.projectDir,
  };
  const found = refusals(view, check);
  const warnings = installWarnings(view, check, (p) => fs.exists(p));
  const unforceable = o.transport === "http" && o.httpUrl === null;
  const blocked = found.length > 0 && (o.force !== true || unforceable);
  const forced = blocked ? [] : found;
  return { found, blocked, forced, warnings: [...forced.map((f) => `FORCED: ${f}`), ...warnings] };
}

function mergeInto(path: string, existing: Record<string, unknown>, o: InstallOptions) {
  try {
    const entries = jevCopsHookEntries(o.hookBinary, o.socket, o.transport, o.httpUrl ?? undefined);
    return mergeHooks(existing, entries, o.hookBinary);
  } catch (cause) {
    throw new InstallError(`${path}: ${message(cause)}`, path);
  }
}

/**
 * Installs the jev-cops hook entries into the scope's settings file. Refuses (status
 * `refused`, nothing written) on a {@link refusals} finding unless `force`; is a no-op
 * (`unchanged`) when the file already carries exactly these entries; prints instead of
 * writing a managed drop-in without root (`printed`). Throws {@link InstallError} on an
 * invalid or unwritable target.
 */
export function installClaudeCodeHooks(o: InstallOptions): InstallResult {
  const fs = o.fs ?? NODE_INSTALL_FS;
  const path = settingsPathFor(o.scope, o);
  const { before, existing } = readTarget(path, fs);
  const view = readView(o, fs);
  const base: Base = { scope: o.scope, path, before, gaps: CLAUDE_CODE_GAPS };
  const a = assess(o, view);
  if (a.blocked) return result(base, { status: "refused", refused: a.found, warnings: a.warnings });
  const merged = mergeInto(path, existing, o);
  const changed = before === null || JSON.stringify(merged) !== JSON.stringify(existing);
  const after = changed ? serializeSettings(merged, before) : before;
  const warnings = [...a.warnings, ...intactWarning(o, view, path, merged)];
  const common = {
    changed,
    after,
    warnings,
    forced: a.forced,
    diff: lineDiff(before, after, path),
  };
  if (o.dryRun === true) return result(base, { ...common, status: "dry-run" });
  if (!changed) return result(base, { ...common, status: "unchanged" });
  if (o.scope === "managed" && o.isRoot !== true && o.force !== true) {
    return result(base, { ...common, status: "printed" });
  }
  return result(base, {
    ...common,
    status: "installed",
    written: true,
    backup: write(o, path, after),
  });
}

/** What an uninstall needs: where, and how (no binary, socket or transport). */
export type UninstallOptions = Omit<
  InstallOptions,
  "socket" | "transport" | "httpUrl" | "hookBinary"
> & {
  readonly hookBinary?: string;
};

function removeWithBackup(o: UninstallOptions, path: string, before: string): string {
  const fs = o.fs ?? NODE_INSTALL_FS;
  const backup = backupPath(path, (o.now ?? (() => new Date()))(), fs);
  try {
    fs.writeFile(backup, before, 0o600);
    removeFile(path, fs);
  } catch (cause) {
    throw new InstallError(`cannot remove ${path}: ${message(cause)}`, path);
  }
  return backup;
}

/**
 * Removes every jev-cops handler from the scope's settings file (and the event arrays and
 * `hooks` object only they filled); a file left as `{}` is deleted. Backed up first; `absent`
 * when there was nothing of ours; `printed` for managed settings without root.
 */
export function uninstallClaudeCodeHooks(o: UninstallOptions): InstallResult {
  const fs = o.fs ?? NODE_INSTALL_FS;
  const path = settingsPathFor(o.scope, o);
  const { before, existing } = readTarget(path, fs);
  const base: Base = { scope: o.scope, path, before, gaps: CLAUDE_CODE_GAPS };
  const { settings, removed } = stripJevCops(existing, o.hookBinary);
  if (before === null || removed === 0) return result(base, { status: "absent" });
  const after = Object.keys(settings).length === 0 ? null : serializeSettings(settings, before);
  const common = { changed: true, after, diff: lineDiff(before, after, path) };
  if (o.dryRun === true) return result(base, { ...common, status: "dry-run" });
  if (o.scope === "managed" && o.isRoot !== true && o.force !== true) {
    return result(base, { ...common, status: "printed" });
  }
  const opts = { ...o, socket: "", transport: "command" as const, httpUrl: null, hookBinary: "" };
  const backup = after === null ? removeWithBackup(o, path, before) : write(opts, path, after);
  return result(base, { ...common, status: "uninstalled", written: true, backup });
}

/**
 * Undoes a written install (the canary failed): the previous text is put back, or the file
 * the install created is removed. A result that wrote nothing is left alone.
 */
export function restoreSettings(
  r: InstallResult,
  o: { readonly fs?: InstallFs; readonly now?: () => Date },
): void {
  if (!r.written) return;
  const fs = o.fs ?? NODE_INSTALL_FS;
  if (r.before === null) {
    removeFile(r.path, fs);
    return;
  }
  const { file, dir } = MODES[r.scope];
  const now = (o.now ?? (() => new Date()))();
  writeFileAtomic(r.path, r.before, { mode: file, dirMode: dir, now, fs, backup: false });
}
