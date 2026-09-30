import { describe, expect, test } from "bun:test";
import { INSTALLED_EVENTS, jevCopsHookEntries } from "./hook-entries.ts";
import { hooksShapeError, mergeHooks, stripJevCops } from "./settings-merge.ts";

type Json = Record<string, unknown>;
const BIN = "/opt/jev-cops/dist/cops-hook";
const SOCK = "/home/dev/.jev-cops/copsd.sock";
const ENTRIES = jevCopsHookEntries(BIN, SOCK, "command");
const LINT = { type: "command", command: "/usr/bin/lint", args: ["--fix"], timeout: 5 };
const STOP = { hooks: [{ type: "command", command: "/usr/bin/notify" }] };

/** A user file with foreign hooks and keys the installer must not touch. */
function foreign(): Json {
  return {
    $schema: "https://json.schemastore.org/claude-code-settings.json",
    model: "opus",
    hooks: {
      Stop: [STOP],
      PreToolUse: [{ matcher: "Edit|Write", hooks: [LINT] }],
    },
    permissions: { allow: ["Read"], deny: ["Bash(rm *)"] },
    zzz: { nested: [1, { a: null }] },
  };
}

const text = (v: unknown) => JSON.stringify(v);

describe("mergeHooks", () => {
  test("an empty file gets one jev-cops group per event", () => {
    const merged = mergeHooks({}, ENTRIES, BIN);
    expect(merged).toEqual({ hooks: { ...ENTRIES } });
  });

  test("foreign hooks, key order and unknown keys are preserved; ours are appended", () => {
    const before = foreign();
    const merged = mergeHooks(before, ENTRIES, BIN);
    expect(Object.keys(merged)).toEqual(Object.keys(before));
    const hooks = merged.hooks as Record<string, unknown[]>;
    expect(Object.keys(hooks)).toEqual([
      "Stop",
      "PreToolUse",
      ...INSTALLED_EVENTS.filter((e) => e !== "PreToolUse"),
    ]);
    expect(hooks.Stop).toEqual([STOP]);
    expect(hooks.PreToolUse).toEqual([
      { matcher: "Edit|Write", hooks: [LINT] },
      ...ENTRIES.PreToolUse,
    ]);
    expect(text(merged.permissions)).toBe(text(before.permissions));
    expect(text(merged.zzz)).toBe(text(before.zzz));
    expect(text(before)).toBe(text(foreign())); // input not mutated
  });

  test("idempotent: merging twice changes nothing", () => {
    const once = mergeHooks(foreign(), ENTRIES, BIN);
    expect(text(mergeHooks(once, ENTRIES, BIN))).toBe(text(once));
  });

  test("stale jev-cops handlers are dropped before ours are appended", () => {
    const stale = {
      type: "command",
      command: "/old/cops-hook",
      args: ["--harness", "claude-code"],
    };
    const shell = { type: "command", command: "/old/cops-hook --harness claude-code" };
    const before: Json = {
      hooks: {
        PreToolUse: [{ hooks: [stale] }, { matcher: "*", hooks: [LINT, shell] }],
        SubagentStart: [{ hooks: [stale] }],
        PostToolUse: [
          { hooks: [{ type: "http", url: "http://127.0.0.1:1/v1/hooks/claude-code" }] },
        ],
      },
    };
    const hooks = mergeHooks(before, ENTRIES, BIN).hooks as Record<string, unknown[]>;
    expect(hooks.PreToolUse).toEqual([{ matcher: "*", hooks: [LINT] }, ...ENTRIES.PreToolUse]);
    expect(hooks.SubagentStart).toEqual([]);
    expect(hooks.PostToolUse).toEqual([...ENTRIES.PostToolUse]);
  });

  test("a new socket replaces the old entries instead of adding a second set", () => {
    const old = mergeHooks({}, jevCopsHookEntries(BIN, "/tmp/old.sock"), BIN);
    const merged = mergeHooks(old, ENTRIES, BIN);
    expect(merged).toEqual({ hooks: { ...ENTRIES } });
  });
});

describe("stripJevCops (uninstall)", () => {
  test("removes only jev-cops handlers and the containers they emptied", () => {
    const installed = mergeHooks(foreign(), ENTRIES, BIN);
    const { settings, removed } = stripJevCops(installed, BIN);
    expect(removed).toBe(INSTALLED_EVENTS.length);
    expect(text(settings)).toBe(text(foreign()));
  });

  test("an install into an empty file uninstalls to an empty object", () => {
    expect(stripJevCops(mergeHooks({}, ENTRIES, BIN), BIN)).toEqual({ settings: {}, removed: 7 });
  });

  test("nothing to remove returns the same object", () => {
    const before = foreign();
    const out = stripJevCops(before, BIN);
    expect(out.removed).toBe(0);
    expect(out.settings).toBe(before);
  });

  test("a mixed group keeps its foreign handlers and its own keys", () => {
    const mine = ENTRIES.PreToolUse[0]?.hooks[0];
    const before: Json = { hooks: { PreToolUse: [{ matcher: "*", hooks: [mine, LINT] }] } };
    expect(stripJevCops(before, BIN).settings).toEqual({
      hooks: { PreToolUse: [{ matcher: "*", hooks: [LINT] }] },
    });
  });

  test("groups that are not objects are kept as they are", () => {
    const before: Json = { hooks: { PreToolUse: ["junk", { hooks: "x" }] } };
    expect(stripJevCops(before, BIN).removed).toBe(0);
  });
});

describe("hooksShapeError: shapes the installer will not merge into", () => {
  test.each([
    [{ hooks: [] }, "`hooks` is not an object"],
    [{ hooks: "x" }, "`hooks` is not an object"],
    [{ hooks: { PreToolUse: {} } }, "`hooks.PreToolUse` is not an array"],
  ])("%p", (settings, message) => {
    expect(hooksShapeError(settings)).toBe(message);
    expect(() => mergeHooks(settings, ENTRIES, BIN)).toThrow(message);
  });

  test("absent or well-formed hooks are fine", () => {
    expect(hooksShapeError({})).toBeNull();
    expect(hooksShapeError(foreign())).toBeNull();
  });
});
