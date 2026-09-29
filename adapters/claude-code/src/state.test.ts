import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CLAUDE_CODE_STATE_FILE, readHarnessVersion } from "./state.ts";

let home = "";
afterEach(() => rmSync(home, { recursive: true, force: true }));

function withState(content: string | null): string {
  home = mkdtempSync(join(tmpdir(), "jvcc-state-"));
  if (content === null) return home;
  mkdirSync(join(home, ".jevdict"));
  writeFileSync(join(home, ".jevdict", CLAUDE_CODE_STATE_FILE), content);
  return home;
}

describe("readHarnessVersion (claude --version as install/doctor recorded it)", () => {
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
