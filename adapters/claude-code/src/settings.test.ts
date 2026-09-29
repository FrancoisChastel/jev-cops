import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { managedDirFor, readSettingsFile, settingsFiles } from "./settings.ts";

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
