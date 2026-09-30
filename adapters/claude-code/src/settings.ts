/**
 * Claude Code settings files the hook reads: where they are (settings#settings-files,
 * managed-settings; PLAN-M1 §2 row 19) and a strict reader. Used by the ConfigChange check
 * (intact.ts), `cops install` (the file each scope writes, the global config for workspace
 * trust) and `cops doctor`.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** Which settings a file is: user, project, local, or managed (root-owned policy). */
export interface SettingsFile {
  readonly scope: "user" | "project" | "local" | "managed";
  readonly path: string;
}

/** A settings file as read: missing, not a JSON object, or its content. */
export type SettingsRead =
  | { readonly kind: "missing" }
  | { readonly kind: "invalid"; readonly error: string }
  | { readonly kind: "ok"; readonly value: Readonly<Record<string, unknown>> };

/** Where to look: the home, the project dir, `CLAUDE_CONFIG_DIR` and the managed dir. */
export interface SettingsLocation {
  readonly home: string;
  readonly projectDir: string;
  readonly configDir: string | null;
  readonly managedDir: string | null;
}

const MANAGED_DIRS: Readonly<Partial<Record<NodeJS.Platform, string>>> = {
  darwin: "/Library/Application Support/ClaudeCode",
  linux: "/etc/claude-code",
  win32: "C:\\Program Files\\ClaudeCode",
};

/** The managed-settings directory of `platform` (managed-settings docs), or null. */
export function managedDirFor(platform: NodeJS.Platform): string | null {
  return MANAGED_DIRS[platform] ?? null;
}

function managedDropIns(dir: string): string[] {
  try {
    // Claude Code "ignores hidden files and files that don't end in .json" (managed-settings).
    const names = readdirSync(join(dir, "managed-settings.d")).filter(
      (n) => n.endsWith(".json") && !n.startsWith("."),
    );
    return names.sort().map((n) => join(dir, "managed-settings.d", n));
  } catch {
    return []; // no drop-in directory: nothing managed there
  }
}

/**
 * The settings files Claude Code loads hooks from, in precedence-free order: user
 * (`$CLAUDE_CONFIG_DIR` or `~/.claude`), project and local under the project dir, then
 * `managed-settings.json` and `managed-settings.d/*.json` (sorted).
 */
export function settingsFiles(loc: SettingsLocation): SettingsFile[] {
  const user = join(loc.configDir ?? join(loc.home, ".claude"), "settings.json");
  const managed = loc.managedDir;
  return [
    { scope: "user", path: user },
    { scope: "project", path: join(loc.projectDir, ".claude", "settings.json") },
    { scope: "local", path: join(loc.projectDir, ".claude", "settings.local.json") },
    ...(managed === null
      ? []
      : [join(managed, "managed-settings.json"), ...managedDropIns(managed)].map((path) => ({
          scope: "managed" as const,
          path,
        }))),
  ];
}

/** The drop-in `cops install claude-code --managed` writes under `managed-settings.d/`. */
export const MANAGED_DROP_IN = "50-jev-cops.json";

/**
 * The file a `cops install claude-code` scope writes: user `$CLAUDE_CONFIG_DIR/settings.json`
 * or `~/.claude/settings.json`; project `.claude/settings.json`; local
 * `.claude/settings.local.json`; managed `<managed dir>/managed-settings.d/50-jev-cops.json`
 * (managed-settings#split-a-file-based-policy-across-teams). Throws for managed on an OS
 * with no managed-settings directory.
 */
export function settingsPathFor(scope: SettingsFile["scope"], loc: SettingsLocation): string {
  switch (scope) {
    case "user":
      return join(loc.configDir ?? join(loc.home, ".claude"), "settings.json");
    case "project":
      return join(loc.projectDir, ".claude", "settings.json");
    case "local":
      return join(loc.projectDir, ".claude", "settings.local.json");
    case "managed":
      if (loc.managedDir === null) throw new Error("no managed-settings directory on this OS");
      return join(loc.managedDir, "managed-settings.d", MANAGED_DROP_IN);
  }
}

/**
 * Claude Code's global config (`~/.claude.json`: workspace trust flags). With
 * `CLAUDE_CONFIG_DIR` set, the docs do not say where it lives: the file inside that
 * directory is tried first, then the one in the home directory.
 */
export function globalConfigPaths(loc: SettingsLocation): string[] {
  const home = join(loc.home, ".claude.json");
  return loc.configDir === null ? [home] : [join(loc.configDir, ".claude.json"), home];
}

/** Parses settings text strictly: JSON whose top level is an object. */
export function parseSettingsText(text: string): SettingsRead {
  try {
    const value: unknown = JSON.parse(text);
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      return { kind: "invalid", error: "not a JSON object" };
    }
    return { kind: "ok", value: value as Record<string, unknown> };
  } catch (cause) {
    return { kind: "invalid", error: cause instanceof Error ? cause.message : "not JSON" };
  }
}

/** Reads a settings file strictly (JSON, an object; no comments or trailing commas). */
export function readSettingsFile(path: string): SettingsRead {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (cause) {
    const code = (cause as { code?: string }).code;
    if (code === "ENOENT") return { kind: "missing" };
    return { kind: "invalid", error: code ?? "unreadable" };
  }
  return parseSettingsText(text);
}
