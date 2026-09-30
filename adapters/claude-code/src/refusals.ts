/**
 * When `cops install claude-code` refuses, and what it warns about (PLAN-M1 §4.3
 * `refusals()`, §5 rows 9 and 14, spec §Harness adapters "Claude Code adapter" and
 * §OpenShell "Without OpenShell"). Pure over a {@link SettingsView}: every settings file
 * Claude Code would load, as read, plus `~/.claude.json` for workspace trust.
 */
import { dirname, join } from "node:path";
import { CLAUDE_CODE_HOOK_PATH, type Transport } from "./hook-entries.ts";
import type { SettingsFile, SettingsRead } from "./settings.ts";

/** Every settings file Claude Code loads for the project, and the global config. */
export interface SettingsView {
  readonly files: readonly { readonly file: SettingsFile; readonly read: SettingsRead }[];
  /** `~/.claude.json` (or under `CLAUDE_CONFIG_DIR`): workspace trust flags. */
  readonly globalConfig: SettingsRead;
}

/** What is being installed, as far as refusals care. */
export interface InstallCheck {
  readonly scope: SettingsFile["scope"];
  readonly transport: Transport;
  /** The daemon's loopback URL (`[daemon] http`), or null when it has none. */
  readonly httpUrl: string | null;
  readonly projectDir: string;
}

type Json = Record<string, unknown>;

function isRecord(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function okFiles(view: SettingsView) {
  return view.files.flatMap((f) => (f.read.kind === "ok" ? [{ ...f, value: f.read.value }] : []));
}

/** A rule that allows every call of a shell tool: `Bash`, `Bash(*)`, `Bash(:*)` (permissions docs). */
const BARE_SHELL = /^(Bash|PowerShell|Monitor)(\(\s*(\*|:\*)\s*\))?$/;

/** Every bare shell allow rule, per file (any scope). */
export function bareShellAllows(view: SettingsView): { path: string; rule: string }[] {
  return okFiles(view).flatMap(({ file, value }) => {
    const allow = isRecord(value.permissions) ? value.permissions.allow : undefined;
    if (!Array.isArray(allow)) return [];
    return allow
      .filter((r): r is string => typeof r === "string" && BARE_SHELL.test(r.trim()))
      .map((rule) => ({ path: file.path, rule }));
  });
}

function setsTrue(view: SettingsView, key: string, managed: boolean): string[] {
  return okFiles(view)
    .filter(({ file, value }) => (file.scope === "managed") === managed && value[key] === true)
    .map(({ file }) => file.path);
}

/** `*` matches anything; every other character is literal (settings-reference#allowedhttphookurls). */
export function urlMatches(pattern: string, url: string): boolean {
  const source = pattern
    .split("*")
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
  return new RegExp(`^${source}$`).test(url);
}

function httpRefusal(view: SettingsView, o: InstallCheck): string | null {
  if (o.transport !== "http") return null;
  if (o.httpUrl === null) {
    return "--transport http needs the daemon's loopback HTTP listener: set [daemon] http in cops.toml (post events only; PreToolUse always uses the command hook)";
  }
  const lists = okFiles(view).filter(({ value }) => value.allowedHttpHookUrls !== undefined);
  if (lists.length === 0) return null;
  const url = `${o.httpUrl}${CLAUDE_CODE_HOOK_PATH}`;
  // An invalid list admits nothing (managed-settings#invalid-entries-in-managed-settings).
  const patterns = lists.flatMap(({ value }) =>
    Array.isArray(value.allowedHttpHookUrls) ? value.allowedHttpHookUrls : [],
  );
  if (patterns.some((p) => typeof p === "string" && urlMatches(p, url))) return null;
  const where = lists.map(({ file }) => file.path).join(", ");
  return `allowedHttpHookUrls (${where}) does not admit ${url}: Claude Code would skip the HTTP post hooks, blinding taint tracking`;
}

/**
 * Why the install must not proceed: a bare `Bash`/`PowerShell`/`Monitor` allow rule in any
 * file (spec; a hook `ask` against it is undocumented), `disableAllHooks` (in managed
 * settings: any scope; elsewhere: a non-managed install), `allowManagedHooksOnly` over a
 * non-managed install, `--transport http` without the daemon's HTTP bind or an allowlist
 * match. `--force` overrides all but the missing HTTP bind.
 */
export function refusals(view: SettingsView, o: InstallCheck): string[] {
  const shell = bareShellAllows(view).map(
    ({ path, rule }) =>
      `${path}: permissions.allow has the bare rule "${rule}": Claude Code does not document a hook ask against it (spec: the installer refuses; --force installs anyway and records the gap)`,
  );
  const managedOff = setsTrue(view, "disableAllHooks", true).map(
    (p) => `${p}: managed settings set disableAllHooks: no hook runs, managed ones included`,
  );
  const off =
    o.scope === "managed"
      ? []
      : setsTrue(view, "disableAllHooks", false).map(
          (p) => `${p}: disableAllHooks is true: Claude Code would not run the cops hook`,
        );
  const managedOnly =
    o.scope === "managed"
      ? []
      : setsTrue(view, "allowManagedHooksOnly", true).map(
          (p) => `${p}: allowManagedHooksOnly blocks user, project and local hooks: use --managed`,
        );
  const http = httpRefusal(view, o);
  return [...shell, ...managedOff, ...off, ...managedOnly, ...(http === null ? [] : [http])];
}

/** The folder whose trust counts: the git repository root, else the folder itself. */
function gitRoot(dir: string, exists: (p: string) => boolean): string | null {
  for (let d = dir; ; d = dirname(d)) {
    if (exists(join(d, ".git"))) return d;
    if (dirname(d) === d) return null;
  }
}

function ancestors(dir: string): string[] {
  const parent = dirname(dir);
  return parent === dir ? [dir] : [dir, ...ancestors(parent)];
}

/**
 * Whether Claude Code would run hooks for `dir` in an interactive session: trust is keyed
 * on the git repository root (a parent's trust does not extend into a repository) or,
 * outside one, on the folder or a trusted parent (`projects[<path>].hasTrustDialogAccepted`).
 */
export function isFolderTrusted(
  globalConfig: SettingsRead,
  dir: string,
  exists: (path: string) => boolean,
): boolean {
  if (globalConfig.kind !== "ok" || !isRecord(globalConfig.value.projects)) return false;
  const projects = globalConfig.value.projects;
  const trusted = (p: string) => {
    const entry = Object.hasOwn(projects, p) ? projects[p] : undefined;
    return isRecord(entry) && entry.hasTrustDialogAccepted === true;
  };
  const root = gitRoot(dir, exists);
  return root === null ? ancestors(dir).some(trusted) : trusted(root);
}

const ALWAYS: readonly string[] = [
  "--dangerously-skip-permissions (bypassPermissions) is out of scope for the hook: a hook deny still blocks there, but nothing asks and the agent may edit what the hook reads; only OpenShell (M2) covers that mode.",
  "Without OpenShell, every deny is best-effort: the agent runs as you and can edit or delete the settings and the hook binary; config-tamper and the ConfigChange hook catch what Claude Code sees (spec §OpenShell).",
];

const NO_HUMAN_MODES: ReadonlySet<unknown> = new Set(["bypassPermissions", "dontAsk"]);

function modeWarnings(view: SettingsView): string[] {
  return okFiles(view).flatMap(({ file, value }) => {
    const mode = isRecord(value.permissions) ? value.permissions.defaultMode : undefined;
    if (!NO_HUMAN_MODES.has(mode)) return [];
    return [
      `${file.path}: permissions.defaultMode is ${String(mode)}: nobody is asked, so holds become denies`,
    ];
  });
}

function unreadable(view: SettingsView): string[] {
  return view.files.flatMap(({ file, read }) =>
    read.kind === "invalid"
      ? [
          `${file.path} is not valid JSON (${read.error}): its hooks and permissions were not checked`,
        ]
      : [],
  );
}

/**
 * What the installer prints but does not refuse: `bypassPermissions`/`dontAsk` default
 * modes, an untrusted folder, unreadable settings, the managed first-wins rule, and always
 * the `--dangerously-skip-permissions` and "Without OpenShell" notices.
 */
export function installWarnings(
  view: SettingsView,
  o: InstallCheck,
  exists: (path: string) => boolean,
): string[] {
  const trust = isFolderTrusted(view.globalConfig, o.projectDir, exists)
    ? []
    : [
        `${o.projectDir} is not a trusted workspace: interactive sessions hold back every hook, this one included, until you accept Claude Code's workspace trust dialog (-p and SDK runs count as trusted)`,
      ];
  const managed =
    o.scope === "managed"
      ? [
          "A managed-settings.d drop-in is read only when the file-based policy is the managed source Claude Code applies: under the default managedSourcesBehavior (first-wins), server-managed settings or an MDM profile with any policy key make it skip the files; check /status.",
        ]
      : [];
  return [...unreadable(view), ...modeWarnings(view), ...trust, ...managed, ...ALWAYS];
}
