import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  globalConfigPaths,
  MANAGED_DROP_IN,
  managedDirFor,
  parseSettingsText,
  readSettingsFile,
  settingsFiles,
  settingsPathFor,
} from "./settings.ts";

let dir = "";
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("settingsFiles: the files Claude Code reads hooks from", () => {
  test("user, project, local, then managed-settings.json and managed-settings.d/*.json in order", () => {
    dir = mkdtempSync(join(tmpdir(), "jvcc-set-"));
    const managed = join(dir, "managed");
    mkdirSync(join(managed, "managed-settings.d"), { recursive: true });
    writeFileSync(join(managed, "managed-settings.d", "50-b.json"), "{}");
    writeFileSync(join(managed, "managed-settings.d", "10-a.json"), "{}");
    writeFileSync(join(managed, "managed-settings.d", "notes.txt"), "");
    writeFileSync(join(managed, "managed-settings.d", ".hidden.json"), "{}");
    const files = settingsFiles({
      home: "/h",
      projectDir: "/p",
      configDir: null,
      managedDir: managed,
    });
    expect(files).toEqual([
      { scope: "user", path: "/h/.claude/settings.json" },
      { scope: "project", path: "/p/.claude/settings.json" },
      { scope: "local", path: "/p/.claude/settings.local.json" },
      { scope: "managed", path: join(managed, "managed-settings.json") },
      { scope: "managed", path: join(managed, "managed-settings.d", "10-a.json") },
      { scope: "managed", path: join(managed, "managed-settings.d", "50-b.json") },
    ]);
  });

  test("CLAUDE_CONFIG_DIR moves the user file; no managed dir, no managed files", () => {
    const files = settingsFiles({
      home: "/h",
      projectDir: "/p",
      configDir: "/cfg",
      managedDir: null,
    });
    expect(files.map((f) => f.path)).toEqual([
      "/cfg/settings.json",
      "/p/.claude/settings.json",
      "/p/.claude/settings.local.json",
    ]);
  });

  test("managedDirFor: the documented directory per OS", () => {
    expect(managedDirFor("darwin")).toBe("/Library/Application Support/ClaudeCode");
    expect(managedDirFor("linux")).toBe("/etc/claude-code");
    expect(managedDirFor("win32")).toBe("C:\\Program Files\\ClaudeCode");
    expect(managedDirFor("aix")).toBeNull();
  });
});

describe("readSettingsFile", () => {
  test("missing, invalid, not an object, and a settings object", () => {
    dir = mkdtempSync(join(tmpdir(), "jvcc-set-"));
    const path = join(dir, "s.json");
    expect(readSettingsFile(path)).toEqual({ kind: "missing" });
    writeFileSync(path, "{ // comment\n}");
    expect(readSettingsFile(path).kind).toBe("invalid");
    writeFileSync(path, "[]");
    expect(readSettingsFile(path)).toMatchObject({ kind: "invalid", error: "not a JSON object" });
    writeFileSync(path, '{"hooks":{}}');
    expect(readSettingsFile(path)).toEqual({ kind: "ok", value: { hooks: {} } });
  });

  test("a directory in the way is invalid, not missing", () => {
    dir = mkdtempSync(join(tmpdir(), "jvcc-set-"));
    expect(readSettingsFile(dir).kind).toBe("invalid");
  });
});

describe("settingsPathFor: the file each install scope writes", () => {
  const loc = { home: "/h", projectDir: "/p", configDir: null, managedDir: "/m" };
  test.each([
    ["user", "/h/.claude/settings.json"],
    ["project", "/p/.claude/settings.json"],
    ["local", "/p/.claude/settings.local.json"],
    ["managed", `/m/managed-settings.d/${MANAGED_DROP_IN}`],
  ] as const)("%s → %s", (scope, path) => {
    expect(settingsPathFor(scope, loc)).toBe(path);
  });

  test("CLAUDE_CONFIG_DIR moves the user file", () => {
    expect(settingsPathFor("user", { ...loc, configDir: "/cfg" })).toBe("/cfg/settings.json");
  });

  test.each([
    ["darwin", "/Library/Application Support/ClaudeCode/managed-settings.d/50-jev-cops.json"],
    ["linux", "/etc/claude-code/managed-settings.d/50-jev-cops.json"],
  ] as const)("managed on %s", (platform, path) => {
    expect(settingsPathFor("managed", { ...loc, managedDir: managedDirFor(platform) })).toBe(path);
  });

  test("managed on Windows and on an OS without a managed directory", () => {
    const win = managedDirFor("win32");
    expect(win).toBe("C:\\Program Files\\ClaudeCode");
    expect(() => settingsPathFor("managed", { ...loc, managedDir: managedDirFor("aix") })).toThrow(
      "no managed-settings directory",
    );
  });
});

describe("globalConfigPaths and parseSettingsText", () => {
  test("~/.claude.json, after the one under CLAUDE_CONFIG_DIR when set", () => {
    const loc = { home: "/h", projectDir: "/p", configDir: null, managedDir: null };
    expect(globalConfigPaths(loc)).toEqual(["/h/.claude.json"]);
    expect(globalConfigPaths({ ...loc, configDir: "/c" })).toEqual([
      "/c/.claude.json",
      "/h/.claude.json",
    ]);
  });

  test("strict JSON objects only", () => {
    expect(parseSettingsText('{"a":1}')).toEqual({ kind: "ok", value: { a: 1 } });
    expect(parseSettingsText("[]").kind).toBe("invalid");
    expect(parseSettingsText('{"a":1,}').kind).toBe("invalid");
  });
});
