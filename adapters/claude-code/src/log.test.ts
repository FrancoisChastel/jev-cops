import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendHookLog, hookLogPath } from "./log.ts";

let home = "";
afterEach(() => rmSync(home, { recursive: true, force: true }));

describe("the hook's local log (~/.jev-cops/claude-code-hook.log)", () => {
  test("creates the directory and appends one line per call, owner-only", () => {
    home = mkdtempSync(join(tmpdir(), "jvcc-log-"));
    const path = hookLogPath(home);
    expect(path).toBe(join(home, ".jev-cops", "claude-code-hook.log"));
    const at = new Date("2026-09-29T10:00:00.000Z");
    appendHookLog(
      path,
      { event: "PreToolUse", session: "sess_a", message: "judge unreachable" },
      at,
    );
    appendHookLog(path, { event: "SessionStart", session: null, message: "two\nlines" }, at);
    expect(readFileSync(path, "utf8")).toBe(
      "2026-09-29T10:00:00.000Z PreToolUse sess_a judge unreachable\n" +
        "2026-09-29T10:00:00.000Z SessionStart - two lines\n",
    );
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  test("caps a long message", () => {
    home = mkdtempSync(join(tmpdir(), "jvcc-log-"));
    const path = hookLogPath(home);
    appendHookLog(
      path,
      { event: "PreToolUse", session: null, message: "x".repeat(5_000) },
      new Date(0),
    );
    expect(readFileSync(path, "utf8").length).toBeLessThan(1_200);
  });

  test("throws when the log cannot be written (the caller reports it)", () => {
    home = mkdtempSync(join(tmpdir(), "jvcc-log-"));
    const path = join(home, "missing-parent-is-a-file");
    writeFileSync(path, "x");
    expect(() =>
      appendHookLog(
        join(path, "log"),
        { event: "PreToolUse", session: null, message: "m" },
        new Date(),
      ),
    ).toThrow();
  });
});
