/**
 * Claude Code settings files the hook reads: where they are (settings#settings-files,
 * managed-settings; PLAN-M1 §2 row 19) and a strict reader. Used by the ConfigChange check
 * (intact.ts); `cops install`/`doctor` (M1 steps 6–7) extend it.
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
    const names = readdirSync(join(dir, "managed-settings.d")).filter((n) => n.endsWith(".json"));
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
