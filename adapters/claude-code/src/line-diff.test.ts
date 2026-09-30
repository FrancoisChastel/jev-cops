import { describe, expect, test } from "bun:test";
import { lineDiff } from "./line-diff.ts";

describe("lineDiff (what --dry-run prints)", () => {
  test("no difference prints nothing", () => {
    expect(lineDiff("a\nb\n", "a\nb\n", "f")).toBe("");
  });

  test("a new file is all additions under a header", () => {
    expect(lineDiff(null, "{\n}\n", "/x/settings.json")).toBe(
      "--- /x/settings.json (absent)\n+++ /x/settings.json\n+{\n+}",
    );
  });

  test("a deleted file is all removals", () => {
    expect(lineDiff("{}\n", null, "f")).toBe("--- f\n+++ f (removed)\n-{}");
  });

  test("changes keep two lines of context and elide the rest", () => {
    const before = ["1", "2", "3", "4", "5", "6", "7", "8"].join("\n");
    const after = ["1", "2", "3", "4", "5", "X", "6", "7", "8"].join("\n");
    expect(lineDiff(before, after, "f")).toBe(
      ["--- f", "+++ f", " …", " 4", " 5", "+X", " 6", " 7", " …"].join("\n"),
    );
  });

  test("a replaced line is a removal then an addition", () => {
    expect(lineDiff("a\nb\nc", "a\nB\nc", "f")).toBe("--- f\n+++ f\n a\n-b\n+B\n c");
  });

  test("very large inputs fall back to a whole replacement", () => {
    const big = Array.from({ length: 3000 }, (_, i) => `l${i}`).join("\n");
    const out = lineDiff(big, `${big}\nnew`, "f").split("\n");
    expect(out.filter((l) => l.startsWith("-"))).toHaveLength(3001);
    expect(out.at(-1)).toBe("+new");
  });
});
