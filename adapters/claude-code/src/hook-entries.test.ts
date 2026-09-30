import { describe, expect, test } from "bun:test";
import {
  CLAUDE_CODE_HOOK_PATH,
  HOOK_TIMEOUTS_S,
  INSTALLED_EVENTS,
  isJevCopsEntry,
  jevCopsHookEntries,
} from "./hook-entries.ts";
import { MIN_TIMEOUT_S, REQUIRED_EVENTS } from "./intact.ts";

const BIN = "/opt/jev-cops/dist/cops-hook";
const SOCK = "/home/dev/.jev-cops/copsd.sock";
const URL_ = "http://127.0.0.1:8787";

describe("jevCopsHookEntries (PLAN-M1 §4.3)", () => {
  test("command transport: exec form on every event, no matcher, the plan's timeouts", () => {
    const entries = jevCopsHookEntries(BIN, SOCK, "command");
    expect(Object.keys(entries)).toEqual([...INSTALLED_EVENTS]);
    for (const event of INSTALLED_EVENTS) {
      expect(entries[event]).toEqual([
        {
          hooks: [
            {
              type: "command",
              command: BIN,
              args: ["--harness", "claude-code", "--socket", SOCK],
              timeout: HOOK_TIMEOUTS_S[event],
            },
          ],
        },
      ]);
    }
    expect(HOOK_TIMEOUTS_S).toMatchObject({ PreToolUse: 30, PostToolUse: 15, SessionEnd: 10 });
  });

  test("every timeout is above the hook's own deadline (intact.ts MIN_TIMEOUT_S)", () => {
    for (const event of REQUIRED_EVENTS) {
      expect(HOOK_TIMEOUTS_S[event]).toBeGreaterThanOrEqual(MIN_TIMEOUT_S[event]);
    }
  });

  test("http transport: post events over HTTP, the rest carry --http-url", () => {
    const entries = jevCopsHookEntries(BIN, SOCK, "http", URL_);
    expect(entries.PostToolUse).toEqual([
      { hooks: [{ type: "http", url: `${URL_}${CLAUDE_CODE_HOOK_PATH}`, timeout: 15 }] },
    ]);
    expect(entries.PostToolUseFailure[0]?.hooks[0]).toMatchObject({ type: "http" });
    expect(entries.PreToolUse[0]?.hooks[0]).toMatchObject({
      type: "command",
      args: ["--harness", "claude-code", "--socket", SOCK, "--http-url", URL_],
    });
  });

  test.each([
    ["a relative binary", () => jevCopsHookEntries("cops-hook", SOCK, "command")],
    ["a relative socket", () => jevCopsHookEntries(BIN, "copsd.sock", "command")],
    ["http without a URL", () => jevCopsHookEntries(BIN, SOCK, "http")],
    ["a non-loopback URL", () => jevCopsHookEntries(BIN, SOCK, "http", "http://10.0.0.1:80")],
  ])("refuses %s", (_why, build) => {
    expect(build).toThrow();
  });
});

describe("isJevCopsEntry: which handlers the installer owns", () => {
  const args = ["--harness", "claude-code", "--socket", SOCK];
  test.each([
    ["the compiled hook", { type: "command", command: BIN, args }],
    ["another cops-hook path", { type: "command", command: "/usr/local/bin/cops-hook", args }],
    ["cops hook", { type: "command", command: "/usr/bin/cops", args: ["hook", ...args] }],
    [
      "bun + hook-main.ts",
      { type: "command", command: "/b/bun", args: ["/r/hook-main.ts", ...args] },
    ],
    ["--harness=claude-code", { type: "command", command: BIN, args: ["--harness=claude-code"] }],
    ["shell form", { type: "command", command: "/x/cops-hook --harness claude-code" }],
    ["the daemon's HTTP route", { type: "http", url: `${URL_}${CLAUDE_CODE_HOOK_PATH}` }],
  ])("owns %s", (_name, handler) => {
    expect(isJevCopsEntry(handler)).toBe(true);
  });

  test("owns any binary named as the installer's own", () => {
    expect(isJevCopsEntry({ type: "command", command: "/x/renamed", args }, "/x/renamed")).toBe(
      true,
    );
  });

  test.each([
    ["a foreign command", { type: "command", command: "/usr/bin/lint", args: [] }],
    ["cops-hook for another harness", { type: "command", command: BIN, args: ["--harness", "pi"] }],
    ["an unrelated binary with our args", { type: "command", command: "/x/renamed", args }],
    ["a foreign shell hook", { type: "command", command: "echo cops-hook" }],
    ["a foreign HTTP hook", { type: "http", url: "http://127.0.0.1:9/other" }],
    ["an HTTP hook with a bad URL", { type: "http", url: "::" }],
    ["a prompt hook", { type: "prompt", prompt: "cops-hook --harness claude-code" }],
    ["not an object", "cops-hook"],
    ["non-string args", { type: "command", command: BIN, args: [1, 2] }],
  ])("does not own %s", (_name, handler) => {
    expect(isJevCopsEntry(handler)).toBe(false);
  });
});
