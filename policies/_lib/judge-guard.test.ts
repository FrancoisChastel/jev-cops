import { describe, expect, test } from "bun:test";
import { buildPolicyEvent, type PolicyEvent } from "@jev-cops/core";
import { bashPre, toolEvent } from "../../tests/fixtures/context/index.ts";
import { judgeCliFindings, privateReadFindings, stopFindings } from "./judge-guard.ts";

async function bash(command: string): Promise<PolicyEvent> {
  return buildPolicyEvent(await bashPre(command), null);
}

const PRIVATE = ["/home/dev/.jev-cops", "!/home/dev/.jev-cops/copsd.sock"];

describe("stopFindings", () => {
  test.each([
    ["pkill -f copsd", "pkill -f copsd"],
    ["sudo pkill -TERM -f cops-hook", "sudo pkill -TERM -f cops-hook"],
    ["pkill -f 'cops(d|-hook)'", "pkill -f cops(d|-hook)"],
    ["pkill -f '[copsd'", "pkill -f [copsd"],
    ["killall copsd", "killall copsd"],
    ["systemctl --user stop copsd.service", "systemctl --user stop copsd.service"],
    [
      "launchctl bootout gui/501/dev.jev-cops.copsd",
      "launchctl bootout gui/501/dev.jev-cops.copsd",
    ],
    ["kill -TERM $(pgrep -f cops-hook)", "pgrep -f cops-hook"],
    ["kill $(pgrep -f copsd)", "pgrep -f copsd"],
    ["kill -9 $(pidof copsd)", "pidof copsd"],
    ["pgrep copsd | xargs kill -9", "pgrep copsd"],
    ["timeout 5 pkill -f copsd", "timeout 5 pkill -f copsd"],
    ["env X=1 /usr/bin/killall cops-hook", "env X=1 /usr/bin/killall cops-hook"],
    ["sudo launchctl bootout gui/501/copsd", "sudo launchctl bootout gui/501/copsd"],
    ['bash -c "pkill -f copsd"', "pkill -f copsd"],
    ["find /proc -maxdepth 0 -exec pkill copsd \\;", "find /proc -maxdepth 0 -exec pkill copsd ;"],
  ])("%s is held as a stop", async (command, target) => {
    expect(stopFindings(await bash(command))).toEqual([{ tier: "hold", target, how: "stop" }]);
  });

  test.each([
    "pkill -f 'node server.js'",
    "killall node",
    "pgrep -f copsd",
    "systemctl --user status copsd.service",
    "launchctl list",
    "kill 4242",
    // The stop words as arguments of another program (D-109's any-word bug, queued there).
    "echo pkill -f copsd",
    "grep copsd notes.md",
    "grep -n 'pkill -f copsd' docs/notes.md",
    'git commit -m "pkill copsd on shutdown"',
    "echo systemctl stop copsd.service",
    "printf 'launchctl bootout gui/501/copsd'",
    "echo kill $(pgrep -f copsd)",
    "echo kill; pgrep -f copsd",
    "man pkill",
  ])("%s is not a stop", async (command) => {
    expect(stopFindings(await bash(command))).toEqual([]);
  });
});

describe("privateReadFindings", () => {
  test("a read under a private dir is held", async () => {
    const e = await bash("cat ~/.jev-cops/audit.jsonl");
    expect(privateReadFindings(e, PRIVATE)).toEqual([
      { tier: "hold", target: "/home/dev/.jev-cops/audit.jsonl", how: "private" },
    ]);
  });

  test("the Read tool counts like cat", async () => {
    const n = await toolEvent("Read", "fs.read", { file_path: "/home/dev/.jev-cops/cops.sqlite" });
    expect(privateReadFindings(buildPolicyEvent(n, null), PRIVATE)).toHaveLength(1);
  });

  test("an exempt entry wins when it is longer; an include wins a tie", async () => {
    const socket = await bash("ls -l ~/.jev-cops/copsd.sock");
    expect(privateReadFindings(socket, PRIVATE)).toEqual([]);
    const tie = ["!/home/dev/.jev-cops", "/home/dev/.jev-cops"];
    expect(privateReadFindings(await bash("cat ~/.jev-cops/audit.jsonl"), tie)).toHaveLength(1);
  });

  test("writes and deletes are not private findings (the trees kill them)", async () => {
    expect(privateReadFindings(await bash("rm ~/.jev-cops/audit.jsonl"), PRIVATE)).toEqual([]);
    expect(privateReadFindings(await bash("echo x > ~/.jev-cops/a.log"), PRIVATE)).toEqual([]);
  });

  test("nothing is private without private paths", async () => {
    expect(privateReadFindings(await bash("cat ~/.jev-cops/audit.jsonl"), [])).toEqual([]);
  });
});

describe("judgeCliFindings", () => {
  test.each([
    ["cops explain evt_01M3PP8CT01010000000000000", "cops explain", "private"],
    ["./dist/cops replay ~/.jev-cops/audit.jsonl --json", "cops replay", "private"],
    ["cops install claude-code --uninstall", "cops install", "cli"],
    ["cops budget sess_x --reset", "cops budget", "cli"],
    ['bash -c "cops explain evt"', "cops explain", "private"],
    ["sudo cops budget --reset x", "cops budget", "cli"],
    ["env JEV=1 cops replay a.jsonl", "cops replay", "private"],
    ["command cops install claude-code", "cops install", "cli"],
    ["find . -maxdepth 0 -exec cops explain evt \\;", "cops explain", "private"],
  ] as const)("%s → %s (%s)", async (command, target, how) => {
    expect(judgeCliFindings(await bash(command))).toEqual([{ tier: "hold", target, how }]);
  });

  test.each([
    "echo cops explain",
    "echo cops replay a.jsonl",
    "grep cops README.md",
    'git commit -m "cops budget --reset"',
    'bash -c "echo cops explain"',
    "git cops explain",
    "find . -name cops -exec cat {} +",
  ])("%s does not run cops: no finding", async (command) => {
    expect(judgeCliFindings(await bash(command))).toEqual([]);
  });

  test.each(["cops test policies", "cops budget sess_x", "cops doctor"])(
    "%s is not a judge CLI finding",
    async (command) => {
      expect(judgeCliFindings(await bash(command))).toEqual([]);
    },
  );
});
