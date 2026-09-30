/**
 * The Claude Code settings `cops doctor` reads (read-only): every settings file Claude Code
 * loads hooks from (the adapter's `settingsFiles`, D-087's set), every hook handler in them,
 * which of those are jev-cops's, and how each jev-cops command handler would be spawned.
 */
import { accessSync, constants, realpathSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import {
  entrySelf,
  type HookIdentity,
  type HookSelf,
  parseHookArgs,
  readSettingsFile,
  type SettingsFile,
  type SettingsRead,
  settingsFiles,
} from "@jev-cops/adapter-claude-code";
import type { DoctorEnv } from "./doctor-types.ts";

type Json = Record<string, unknown>;

/** One settings file and what reading it gave. */
export interface SettingsReadOf {
  readonly file: SettingsFile;
  readonly read: SettingsRead;
}

/** The settings Claude Code would load for this home and project. */
export interface SettingsView {
  readonly projectDir: string;
  readonly reads: readonly SettingsReadOf[];
}

/** One hook handler as registered: its event, file, group matcher and the handler itself. */
export interface HandlerRef {
  readonly event: string;
  readonly file: SettingsFile;
  readonly group: Json;
  readonly handler: Json;
}

/** How a jev-cops handler is registered: exec form, shell form (broken), or HTTP (post events). */
export type CopsForm = "exec" | "shell" | "http";

/** A jev-cops command handler resolved as Claude Code would spawn it. */
export interface CopsIdentity {
  readonly command: string;
  readonly args: readonly string[];
  /** The arguments before `--harness` (the script under `bun`, `hook` under `cops`). */
  readonly leading: readonly string[];
  /**
   * The identity the hook this entry starts will compute for itself (the adapter's
   * `entrySelf`, the prediction the installer also uses), or null when nothing resolves.
   */
  readonly self: HookSelf | null;
  /** The `--socket` it passes (default under the home), or null when its flags do not parse. */
  readonly socket: string | null;
  /** The file `command` resolves to (placeholders, PATH), or null when it resolves to nothing. */
  readonly commandFile: string | null;
  /** Equal for handlers that are the same hook (Claude Code runs those once). */
  readonly key: string;
}

/** A value that is a plain JSON object. */
export function isRecord(value: unknown): value is Json {
  return Object.prototype.toString.call(value) === "[object Object]";
}

/** Reads every settings file Claude Code loads hooks from (user, project, local, managed). */
export function readClaudeSettings(e: DoctorEnv): SettingsView {
  const projectDir = e.env.CLAUDE_PROJECT_DIR || e.cwd;
  const location = {
    home: e.home,
    projectDir,
    configDir: e.env.CLAUDE_CONFIG_DIR || null,
    managedDir: e.managedDir,
  };
  const reads = settingsFiles(location).map((file) => ({
    file,
    read: readSettingsFile(file.path),
  }));
  return { projectDir, reads };
}

/** Every hook handler of every event in the files that parsed. */
export function handlersOf(reads: readonly SettingsReadOf[]): HandlerRef[] {
  return reads.flatMap(({ file, read }) => {
    if (read.kind !== "ok" || !isRecord(read.value.hooks)) return [];
    return Object.entries(read.value.hooks).flatMap(([event, groups]) =>
      (Array.isArray(groups) ? groups : [])
        .filter(isRecord)
        .flatMap((group) =>
          (Array.isArray(group.hooks) ? group.hooks : [])
            .filter(isRecord)
            .map((handler) => ({ event, file, group, handler })),
        ),
    );
  });
}

const COPS_BINARIES: ReadonlySet<string> = new Set(["cops-hook", "cops"]);
const HOOK_ROUTE = "/v1/hooks/claude-code";

function harnessIndex(args: readonly string[]): number {
  return args.findIndex(
    (a, i) => (a === "--harness" && args[i + 1] === "claude-code") || a === "--harness=claude-code",
  );
}

function stringArgs(h: Json): string[] | null {
  const args = h.args;
  return Array.isArray(args) && args.every((a) => typeof a === "string") ? args : null;
}

/** How `h` is a jev-cops handler, or null when it is someone else's. */
export function copsForm(h: Json): CopsForm | null {
  if (h.type === "http") {
    return typeof h.url === "string" && h.url.endsWith(HOOK_ROUTE) ? "http" : null;
  }
  if (h.type !== "command" || typeof h.command !== "string") return null;
  const args = stringArgs(h);
  const named = COPS_BINARIES.has(basename(h.command.split(/\s/)[0] ?? ""));
  if (args !== null) return harnessIndex(args) >= 0 || named ? "exec" : null;
  return h.command.includes("claude-code") && (named || h.command.includes("cops"))
    ? "shell"
    : null;
}

/** `path` with symlinks resolved as far as it exists (a socket may not exist yet). */
function realpathOr(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    const parent = dirname(path);
    return parent === path ? path : join(realpathOr(parent), basename(path));
  }
}

/** Whether two paths name the same file (symlinks resolved where they exist, e.g. /tmp). */
export function samePath(a: string, b: string): boolean {
  return a === b || realpathOr(resolve(a)) === realpathOr(resolve(b));
}

/** The file an exec-form `command` spawns (as intact.ts resolves it), or null. */
export function commandFileOf(command: string, projectDir: string, e: DoctorEnv): string | null {
  // biome-ignore lint/suspicious/noTemplateCurlyInString: Claude Code's literal placeholder
  const expanded = command.replaceAll("${CLAUDE_PROJECT_DIR}", projectDir);
  if (expanded.includes("/")) return resolve(projectDir, expanded);
  return e.which(expanded);
}

/** How an exec-form jev-cops handler would run. */
export function identityOf(h: Json, projectDir: string, e: DoctorEnv): CopsIdentity {
  const command = typeof h.command === "string" ? h.command : "";
  const args = stringArgs(h) ?? [];
  const at = harnessIndex(args);
  const leading = at < 0 ? args : args.slice(0, at);
  const flags = at < 0 ? null : parseHookArgs(args.slice(at), e.home);
  const socket = flags?.ok === true ? resolve(flags.socket) : null;
  const commandFile = commandFileOf(command, projectDir, e);
  const self = entrySelf(command, args, { projectDir, path: e.env.PATH ?? "" })?.self ?? null;
  const program = self === null ? [commandFile ?? command] : [self.program, ...self.leading];
  const key = [...program, socket ?? "?"]
    .map((part) => (isAbsolute(part) ? realpathOr(part) : part))
    .join("\u0000");
  return { command, args, leading, self, socket, commandFile, key };
}

/**
 * The adapter's {@link HookIdentity} for `id`: the identity its hook computes for itself
 * (hook-identity.ts), so the doctor's "intact" is the hook's own ConfigChange check (D-087).
 */
export function hookIdentityOf(id: CopsIdentity, view: SettingsView, e: DoctorEnv): HookIdentity {
  const unresolved: HookSelf = {
    program: id.commandFile ?? id.command,
    runtime: null,
    leading: [],
  };
  return {
    ...(id.self ?? unresolved),
    socket: id.socket ?? "",
    home: e.home,
    projectDir: view.projectDir,
    path: e.env.PATH ?? "",
  };
}

/** Why `path` cannot be spawned (missing, not a file, not executable), or null. */
export function unrunnable(path: string): string | null {
  try {
    if (!statSync(path).isFile()) return "is not a file";
    accessSync(path, constants.X_OK);
    return null;
  } catch (cause) {
    const code = (cause as { code?: string }).code;
    return code === "ENOENT"
      ? "does not exist"
      : code === "EACCES"
        ? "is not executable"
        : `cannot be run (${code ?? "unknown"})`;
  }
}
