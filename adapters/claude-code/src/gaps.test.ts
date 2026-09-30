import { describe, expect, test } from "bun:test";
import * as adapter from "./index.ts";

describe("CLAUDE_CODE_GAPS", () => {
  test("every gap is one non-empty paragraph, and they are distinct", () => {
    const gaps = adapter.CLAUDE_CODE_GAPS;
    expect(gaps.length).toBeGreaterThanOrEqual(15);
    for (const gap of gaps) {
      expect(gap.trim()).toBe(gap);
      expect(gap).not.toContain("\n");
      expect(gap.length).toBeGreaterThan(20);
    }
    expect(new Set(gaps).size).toBe(gaps.length);
  });

  test("what the M1 live capture found is printed", () => {
    const text = adapter.CLAUDE_CODE_GAPS.join("\n");
    // The ask text (with the daemon's detail) lands in agent-readable files, never in context.
    expect(text).toContain("~/.claude/projects/");
    // The Agent SDK starts claude without -p: its print-only flags count as headless.
    expect(text).toContain("`--output-format`/`--input-format`");
    // Only `cops install` records the version (D-092); SDK runs bundle their own claude.
    expect(text).toContain("recorded in ~/.jev-cops/claude-code.json by `cops install`");
    expect(text).not.toContain("by install or doctor");
  });

  test("the package entry exports the hook runtime", () => {
    expect(typeof adapter.runHook).toBe("function");
    expect(typeof adapter.runHookProcess).toBe("function");
    expect(typeof adapter.checkIntact).toBe("function");
  });
});
