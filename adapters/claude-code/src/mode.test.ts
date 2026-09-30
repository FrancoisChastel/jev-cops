import { describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  detectMode,
  isClaude,
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
    // The Agent SDK (0.3.285, bundled claude 2.1.285) passes no -p: stream-json in and out.
    // Both flags exist only in print mode, so they mean headless unless a host is given.
    [
      [
        "/sdk/node_modules/@anthropic-ai/claude-agent-sdk-darwin-arm64/claude",
        ...["--output-format", "stream-json", "--verbose", "--input-format", "stream-json"],
        ...["--setting-sources=user", "--permission-mode", "default"],
      ],
      "headless",
    ],
    [
      [
        "claude",
        ...["--output-format", "stream-json", "--verbose", "--input-format", "stream-json"],
        ...["--permission-prompt-tool", "stdio"],
      ],
      "interactive",
    ],
    [["claude", "--output-format=json", "go"], "headless"],
    [["claude", "--input-format", "stream-json"], "headless"],
    [
      [
        "claude",
        ...["--output-format", "stream-json", "--permission-prompt-tool", "stdio"],
        ...["--permission-prompts", "none"],
      ],
      "headless",
    ],
  ] as const)("%p → %s", (args, mode) => {
    expect(modeOfArgs(args)).toBe(mode);
  });
});

function table(procs: Record<number, ProcInfo>) {
  return (pid: number): ProcInfo | null => procs[pid] ?? null;
}

describe("isClaude", () => {
  test.each([
    [["claude", "-p"], true],
    [["/opt/homebrew/bin/claude"], true],
    [["C:\\Users\\me\\.local\\bin\\claude.exe", "-p"], true],
    [["node", "/usr/lib/node_modules/@anthropic-ai/claude-code/cli.js", "-p"], true],
    [["bun", "/repo/adapters/claude-code/testing/claude.ts", "-p"], true],
    [["bun", "test"], false],
    [["/usr/bin/nix", "develop"], false],
    [[], false],
  ] as const)("%p → %p", (args, expected) => {
    expect(isClaude(args)).toBe(expected);
  });
});

describe("detectMode: the parent claude's argv", () => {
  test("exec form: the hook's parent is claude", () => {
    const read = table({ 10: { ppid: 1, args: ["claude", "-p", "go"] } });
    expect(detectMode(10, read)).toBe("headless");
    expect(detectMode(10, table({ 10: { ppid: 1, args: ["claude"] } }))).toBe("interactive");
  });

  test("shell form: shells are unwrapped, nested ones and Windows ones included", () => {
    const read = table({
      10: { ppid: 9, args: ["/bin/sh", "-c", "cops-hook --harness claude-code"] },
      9: { ppid: 1, args: ["claude"] },
    });
    expect(detectMode(10, read)).toBe("interactive");
    const nested = table({
      10: { ppid: 9, args: ["bash", "-c", "x"] },
      9: { ppid: 8, args: ["-zsh"] },
      8: { ppid: 7, args: ["C:\\Windows\\System32\\cmd.exe", "/c", "x"] },
      7: { ppid: 1, args: ["claude"] },
    });
    expect(detectMode(10, nested)).toBe("interactive");
  });

  test("a parent that is not recognizably claude counts as headless", () => {
    expect(detectMode(10, table({ 10: { ppid: 1, args: ["bun", "test"] } }))).toBe("headless");
    expect(
      detectMode(10, table({ 10: { ppid: 1, args: ["direnv", "exec", ".", "claude"] } })),
    ).toBe("headless");
  });

  test("an unreadable process, or too many shells, counts as headless", () => {
    expect(detectMode(10, table({}))).toBe("headless");
    const orphan = table({ 10: { ppid: 9, args: ["sh", "-c", "x"] } });
    expect(detectMode(10, orphan)).toBe("headless");
    const shells = table({
      10: { ppid: 9, args: ["sh"] },
      9: { ppid: 8, args: ["sh"] },
      8: { ppid: 7, args: ["sh"] },
      7: { ppid: 6, args: ["sh"] },
      6: { ppid: 1, args: ["claude"] },
    });
    expect(detectMode(10, shells)).toBe("headless");
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

  test("readProc never runs a `ps` found on PATH: an agent-writable PATH entry cannot fake the parent", () => {
    // Found by the M1 live capture: `/opt/homebrew/bin` is user-writable on Apple-silicon
    // Homebrew and precedes /bin, so a planted `ps` could make a headless run look
    // interactive. The hook starts with Claude Code's PATH, so the reader runs in a child
    // process started with the planted directory first.
    const dir = mkdtempSync(join(tmpdir(), "jvcc-ps-"));
    const fake = join(dir, "ps");
    writeFileSync(fake, "#!/bin/sh\necho '1 claude'\n");
    chmodSync(fake, 0o755);
    const mode = join(import.meta.dir, "mode.ts");
    const code = `const { readProc } = await import(${JSON.stringify(mode)}); console.log(JSON.stringify(readProc(process.pid)));`;
    try {
      const run = Bun.spawnSync([process.execPath, "-e", code], {
        env: { PATH: `${dir}:${process.env.PATH ?? "/usr/bin:/bin"}` },
        stdout: "pipe",
      });
      const seen = JSON.parse(run.stdout.toString()) as ProcInfo | null;
      expect(seen?.args).not.toEqual(["claude"]);
      expect(seen?.args.join(" ")).toContain("readProc");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
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
