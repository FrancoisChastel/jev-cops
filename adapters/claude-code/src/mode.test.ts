import { describe, expect, test } from "bun:test";
import {
  detectMode,
  modeOfArgs,
  type ProcInfo,
  parseProcCmdline,
  parseProcStat,
  parsePsLine,
  readProc,
} from "./mode.ts";

describe("modeOfArgs: headless iff print mode without a permission host (plan §2 row 10)", () => {
  test.each([
    [["claude"], "interactive"],
    [["claude", "fix the test"], "interactive"],
    [["claude", "-p", "fix the test"], "headless"],
    [["claude", "fix the test", "--print"], "headless"],
    [["/opt/homebrew/bin/claude", "-cp", "go"], "headless"],
    [["node", "/usr/lib/cli.js", "-p", "x"], "headless"],
    [["claude", "-p", "--permission-prompt-tool", "mcp__h__ask"], "interactive"],
    [["claude", "-p", "--permission-prompt-tool=stdio"], "interactive"],
    [
      ["claude", "-p", "--permission-prompt-tool", "stdio", "--permission-prompts", "none"],
      "headless",
    ],
    [["claude", "-p", "--permission-prompts=none", "--permission-prompt-tool=stdio"], "headless"],
    [["claude", "--permission-prompts", "none"], "interactive"],
    [["claude", "--print-config"], "interactive"],
    [["claude", "fix -p flag"], "interactive"],
  ] as const)("%p → %s", (args, mode) => {
    expect(modeOfArgs(args)).toBe(mode);
  });
});

function table(procs: Record<number, ProcInfo>) {
  return (pid: number): ProcInfo | null => procs[pid] ?? null;
}

describe("detectMode: the parent claude's argv", () => {
  test("exec form: the hook's parent is claude", () => {
    const read = table({ 10: { ppid: 1, args: ["claude", "-p", "go"] } });
    expect(detectMode(10, read)).toBe("headless");
  });

  test("shell form: the parent is a shell, so its parent is read", () => {
    const read = table({
      10: { ppid: 9, args: ["/bin/sh", "-c", "jevdict-hook --harness claude-code"] },
      9: { ppid: 1, args: ["claude"] },
    });
    expect(detectMode(10, read)).toBe("interactive");
    const headless = table({
      10: { ppid: 9, args: ["bash", "-c", "x"] },
      9: { ppid: 1, args: ["claude", "--print", "go"] },
    });
    expect(detectMode(10, headless)).toBe("headless");
  });

  test("an unreadable parent counts as headless (no human: a hold is denied, never asked)", () => {
    expect(detectMode(10, table({}))).toBe("headless");
    const orphan = table({ 10: { ppid: 9, args: ["sh", "-c", "x"] } });
    expect(detectMode(10, orphan)).toBe("headless");
  });
});

describe("process readers", () => {
  test("readProc reads this test process", () => {
    const self = readProc(process.pid);
    expect(self?.ppid).toBe(process.ppid);
    expect(self?.args.join(" ")).toContain("test");
  });

  test("readProc of a pid that does not exist, or without a ps to run, is null", () => {
    expect(readProc(2 ** 22 + 12_345)).toBeNull();
    expect(readProc(0)).toBeNull();
    if (process.platform !== "linux") expect(readProc(process.pid, "/nonexistent/ps")).toBeNull();
  });

  test("parsePsLine: `ps -o ppid= -o args=`", () => {
    expect(parsePsLine("  4242 claude -p fix it\n")).toEqual({
      ppid: 4242,
      args: ["claude", "-p", "fix", "it"],
    });
    expect(parsePsLine("")).toBeNull();
    expect(parsePsLine("abc claude")).toBeNull();
  });

  test("parseProcStat: the ppid after the (comm) field, even with spaces and parens in it", () => {
    expect(parseProcStat("1234 (my (odd) cmd) S 777 1234 1234 0 -1")).toBe(777);
    expect(parseProcStat("garbage")).toBeNull();
  });

  test("parseProcCmdline: NUL-separated argv", () => {
    expect(parseProcCmdline("claude\0-p\0fix it\0")).toEqual(["claude", "-p", "fix it"]);
    expect(parseProcCmdline("")).toEqual([]);
  });
});
