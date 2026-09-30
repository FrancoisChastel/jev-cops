import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseMeta,
  parseSteps,
  renderReport,
  reportFor,
  runReportCli,
  verdictLines,
} from "./report.ts";

describe("parsing", () => {
  test("steps.tsv: valid lines kept, tabs in titles kept, junk skipped", () => {
    expect(
      parseSteps("1.1\tPASS\tcops --version\n\n1.2\tFAIL\ta\tb\nbad\tMAYBE\tx\n\tPASS\ty"),
    ).toEqual([
      { id: "1.1", status: "PASS", title: "cops --version" },
      { id: "1.2", status: "FAIL", title: "a\tb" },
    ]);
  });

  test("meta lines and verdict lines", () => {
    expect(parseMeta("date: 2026-09-30\nnot a pair\n: empty key")).toEqual([
      ["date", "2026-09-30"],
    ]);
    expect(
      verdictLines(
        "$ cops audit verify\nFAIL  chain broken\n==> PASS version\n==> SKIP mock judge\n==> FAIL x",
      ),
    ).toEqual(["PASS version", "SKIP mock judge", "FAIL x"]);
  });
});

describe("renderReport", () => {
  const steps = parseSteps("1.1\tPASS\tversion | help\n3.4\tFAIL\tallow\n3.13\tSKIP\tmock judge");
  const evidence = (id: string) =>
    ({ "1.1": "==> PASS prints `0.1.0`", "3.4": "$ claude -p\n==> FAIL audit has an allow" })[id] ??
    "";
  const md = renderReport(steps, [["Claude Code", "2.1.286"]], evidence);

  test("counts, meta, the table with escaped cells", () => {
    expect(md).toContain("**1 passed · 1 failed · 1 skipped** (3 steps)");
    expect(md).toContain("- Claude Code: 2.1.286");
    expect(md).toContain(
      "| [1.1](./e2e/steps/1.1.txt) | PASS | version \\| help | PASS prints '0.1.0' |",
    );
    expect(md).toContain("| [3.13](./e2e/steps/3.13.txt) | SKIP | mock judge |  |");
  });

  test("failures get their full evidence", () => {
    expect(md).toContain("## Failures");
    expect(md).toContain("### 3.4 allow");
    expect(md).toContain("```text\n$ claude -p\n==> FAIL audit has an allow\n```");
  });

  test("no failures section when all pass", () => {
    expect(renderReport(parseSteps("1\tPASS\tok"), [], () => "")).not.toContain("## Failures");
  });
});

describe("reportFor and the command line", () => {
  test("reads a run dir; missing files are empty", () => {
    const dir = mkdtempSync(join(tmpdir(), "live-report-"));
    mkdirSync(join(dir, "steps"));
    writeFileSync(join(dir, "steps.tsv"), "0.1\tPASS\tpack\n");
    writeFileSync(join(dir, "meta.txt"), "jev-cops: 0.1.0\n");
    writeFileSync(join(dir, "steps", "0.1.txt"), "==> PASS 11 tarballs\n");
    const md = reportFor(dir);
    expect(md).toContain("| [0.1](./e2e/steps/0.1.txt) | PASS | pack | PASS 11 tarballs |");
    expect(md).toContain("- jev-cops: 0.1.0");
    const out: string[] = [];
    const write = (fd: 1 | 2, t: string) => {
      out.push(`${fd}${t.slice(0, 12)}`);
    };
    expect(runReportCli([], write)).toBe(2);
    expect(runReportCli([join(dir, "missing")], write)).toBe(0);
    expect(out).toEqual(["2usage: bun s", "1# jev-cops l"]);
  });
});
