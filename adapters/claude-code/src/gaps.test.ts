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

  test("the package entry exports the hook runtime", () => {
    expect(typeof adapter.runHook).toBe("function");
    expect(typeof adapter.runHookProcess).toBe("function");
    expect(typeof adapter.checkIntact).toBe("function");
  });
});
