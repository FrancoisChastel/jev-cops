import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CLAUDE_CODE_STATE_FILE,
  claudeCodeStatePath,
  parseClaudeVersion,
  readHarnessVersion,
} from "./state.ts";

let home = "";
afterEach(() => rmSync(home, { recursive: true, force: true }));

function withState(content: string | null): string {
  home = mkdtempSync(join(tmpdir(), "jvcc-state-"));
  if (content === null) return home;
  mkdirSync(join(home, ".jev-cops"));
  writeFileSync(join(home, ".jev-cops", CLAUDE_CODE_STATE_FILE), content);
  return home;
}

describe("readHarnessVersion (claude --version as cops install recorded it)", () => {
  test("reads a recorded version", () => {
    const h = withState(JSON.stringify({ claude_version: "2.1.285" }));
    expect(readHarnessVersion(h)).toBe("2.1.285");
  });

  test.each([
    ["no state file", null],
    ["invalid JSON", "{"],
    ["no version", "{}"],
    ["a version that is not one", JSON.stringify({ claude_version: "latest; rm -rf /" })],
    ["an over-long version", JSON.stringify({ claude_version: `1.2.3-${"x".repeat(80)}` })],
    ["an array", "[]"],
  ])("%s → null (omitted from events)", (_name, content) => {
    expect(readHarnessVersion(withState(content))).toBeNull();
  });
});

describe("parseClaudeVersion (`claude --version` prints `2.1.280 (Claude Code)`)", () => {
  test.each([
    ["2.1.280 (Claude Code)\n", "2.1.280"],
    ["2.1.285", "2.1.285"],
    ["2.2.0-beta.1 (Claude Code)", "2.2.0-beta.1"],
    ["Claude Code 2.1.280", null],
    ["", null],
    [`1.2.3-${"x".repeat(80)}`, null],
  ])("%p → %p", (output, version) => {
    expect(parseClaudeVersion(output)).toBe(version);
  });

  test("the state file lives under ~/.jev-cops", () => {
    expect(claudeCodeStatePath("/h")).toBe(`/h/.jev-cops/${CLAUDE_CODE_STATE_FILE}`);
  });
});
