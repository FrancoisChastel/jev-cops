import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  checkIntact,
  type HookIdentity,
  isJevCopsHandler,
  MIN_TIMEOUT_S,
  REQUIRED_EVENTS,
  registeredEvents,
} from "./intact.ts";
import type { SettingsFile, SettingsRead } from "./settings.ts";

let dir = "";
let bin = "";
let id: HookIdentity;
beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "jvcc-int-")));
  bin = join(dir, "cops-hook");
  writeFileSync(bin, "#!/bin/sh\n");
  chmodSync(bin, 0o755);
  id = {
    command: bin,
    leading: [],
    socket: "/run/j.sock",
    home: "/home/dev",
    projectDir: dir,
    path: "/usr/bin",
  };
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

type Json = Record<string, unknown>;
const ARGS = ["--harness", "claude-code", "--socket", "/run/j.sock"];
const handler = (over: Json = {}): Json => ({ type: "command", command: bin, args: ARGS, ...over });

/** A settings object registering jev-cops on every required event (what the installer writes). */
function jevCopsSettings(over: Json = {}): Json {
  const groups = (event: string) => [
    { hooks: [handler({ timeout: event === "PreToolUse" ? 30 : 10 })] },
  ];
  return { hooks: Object.fromEntries(REQUIRED_EVENTS.map((e) => [e, groups(e)])), ...over };
}

const file = (scope: SettingsFile["scope"], path = `/${scope}.json`): SettingsFile => ({
  scope,
  path,
});
const ok = (value: Json): SettingsRead => ({ kind: "ok", value });
const MISSING: SettingsRead = { kind: "missing" };

describe("isJevCopsHandler: this hook, on every call of the event", () => {
  test("the installer's entry is jev-cops's", () => {
    expect(isJevCopsHandler("PreToolUse", {}, handler(), id)).toBe(true);
    expect(isJevCopsHandler("PreToolUse", { matcher: "*" }, handler({ timeout: 30 }), id)).toBe(
      true,
    );
    expect(isJevCopsHandler("PreToolUse", { matcher: "" }, handler(), id)).toBe(true);
  });

  test.each([
    ["a matcher that is not every tool", { matcher: "Bash" }, {}],
    ["a regex matcher", { matcher: ".*" }, {}],
    ["an if condition", {}, { if: "Bash(rm *)" }],
    ["async", {}, { async: true }],
    ["asyncRewake", {}, { asyncRewake: true }],
    ["a timeout under the hook's deadline", {}, { timeout: MIN_TIMEOUT_S.PreToolUse - 1 }],
    ["shell form (no args)", {}, { args: undefined, command: `${bin} --harness claude-code` }],
    ["another binary", {}, { command: "/bin/true" }],
    ["a missing binary", {}, { command: join(dir, "gone") }],
    ["another socket", {}, { args: ["--harness", "claude-code", "--socket", "/tmp/evil.sock"] }],
    ["the default socket instead of the hook's", {}, { args: ["--harness", "claude-code"] }],
    ["an unknown flag", {}, { args: [...ARGS, "--verbose"] }],
    ["a non-string arg", {}, { args: ["--harness", 1] }],
    ["an http handler", {}, { type: "http", url: "http://127.0.0.1:7/v1/hooks/claude-code" }],
  ] as const)("not with %s", (_name, group, over) => {
    expect(isJevCopsHandler("PreToolUse", group, handler(over), id)).toBe(false);
  });

  test("a symlink to the binary and a bare name on PATH are the same hook", () => {
    const link = join(dir, "link-hook");
    symlinkSync(bin, link);
    expect(isJevCopsHandler("PreToolUse", {}, handler({ command: link }), id)).toBe(true);
    const onPath = { ...id, path: `/nonexistent:${dir}` };
    expect(isJevCopsHandler("PreToolUse", {}, handler({ command: "cops-hook" }), onPath)).toBe(
      true,
    );
    expect(isJevCopsHandler("PreToolUse", {}, handler({ command: "cops-hook" }), id)).toBe(false);
  });

  test("the CLAUDE_PROJECT_DIR placeholder is substituted in the command", () => {
    // biome-ignore lint/suspicious/noTemplateCurlyInString: Claude Code's literal placeholder
    const entry = handler({ command: "${CLAUDE_PROJECT_DIR}/cops-hook" });
    expect(isJevCopsHandler("PreToolUse", {}, entry, id)).toBe(true);
  });

  test("from source: bun, the same script, then the flags", () => {
    const script = join(dir, "hook-main.ts");
    writeFileSync(script, "");
    const src = { ...id, leading: [script] };
    expect(isJevCopsHandler("PreToolUse", {}, handler({ args: [script, ...ARGS] }), src)).toBe(
      true,
    );
    const other = join(dir, "other.ts");
    writeFileSync(other, "");
    expect(isJevCopsHandler("PreToolUse", {}, handler({ args: [other, ...ARGS] }), src)).toBe(
      false,
    );
  });

  test("`cops hook`: the subcommand must be there", () => {
    const cli = { ...id, leading: ["hook"] };
    expect(isJevCopsHandler("PreToolUse", {}, handler({ args: ["hook", ...ARGS] }), cli)).toBe(
      true,
    );
    expect(isJevCopsHandler("PreToolUse", {}, handler(), cli)).toBe(false);
  });

  test("UserPromptSubmit ignores matchers", () => {
    expect(isJevCopsHandler("UserPromptSubmit", { matcher: "x" }, handler(), id)).toBe(true);
  });

  test("an HTTP post handler is not intact: the hook cannot tell a decoy port from the daemon's", () => {
    const http = { type: "http", url: "http://127.0.0.1:8791/v1/hooks/claude-code", timeout: 15 };
    expect(isJevCopsHandler("PostToolUse", {}, http, id)).toBe(false);
  });

  describe("--transport http: the hook carries the daemon's URL (--http-url)", () => {
    const URL_ = "http://127.0.0.1:8791";
    const withUrl = (): HookIdentity => ({ ...id, httpUrl: URL_ });
    const http = (over: Json = {}): Json => ({
      type: "http",
      url: `${URL_}/v1/hooks/claude-code`,
      timeout: 15,
      ...over,
    });
    const httpArgs = [...ARGS, "--http-url", URL_];

    test("an HTTP post handler to that URL is intact on post events only", () => {
      expect(isJevCopsHandler("PostToolUse", {}, http(), withUrl())).toBe(true);
      expect(isJevCopsHandler("PostToolUseFailure", { matcher: "*" }, http(), withUrl())).toBe(
        true,
      );
      expect(isJevCopsHandler("PreToolUse", {}, http(), withUrl())).toBe(false);
    });

    test.each([
      ["a decoy port", { url: "http://127.0.0.1:9999/v1/hooks/claude-code" }],
      ["another route", { url: `${URL_}/v1/observe` }],
      ["a short timeout", { timeout: 1 }],
      ["async", { async: true }],
    ])("not with %s", (_name, over) => {
      expect(isJevCopsHandler("PostToolUse", {}, http(over), withUrl())).toBe(false);
    });

    test("the command entries must carry the same --http-url as the running hook", () => {
      expect(isJevCopsHandler("PreToolUse", {}, handler({ args: httpArgs }), withUrl())).toBe(true);
      expect(isJevCopsHandler("PreToolUse", {}, handler(), withUrl())).toBe(false);
      expect(isJevCopsHandler("PreToolUse", {}, handler({ args: httpArgs }), id)).toBe(false);
    });
  });
});

describe("registeredEvents", () => {
  test("lists the required events a settings object registers jev-cops on", () => {
    expect([...registeredEvents(jevCopsSettings(), id)].sort()).toEqual(
      [...REQUIRED_EVENTS].sort(),
    );
    const partial = { hooks: { PreToolUse: [{ hooks: [handler()] }], Stop: "junk" } };
    expect([...registeredEvents(partial, id)]).toEqual(["PreToolUse"]);
    expect([...registeredEvents({ hooks: [] }, id)]).toEqual([]);
    expect([...registeredEvents({}, id)]).toEqual([]);
  });

  test("a foreign handler next to jev-cops's does not matter", () => {
    const s = jevCopsSettings();
    const hooks = s.hooks as Record<string, Json[]>;
    const withForeign = {
      hooks: {
        ...hooks,
        PreToolUse: [{ hooks: [{ type: "command", command: "/x" }] }, ...(hooks.PreToolUse ?? [])],
      },
    };
    expect(registeredEvents(withForeign, id).has("PreToolUse")).toBe(true);
  });
});

describe("checkIntact: after the change, the cops hook is still in force", () => {
  test("installed in user settings; an unrelated project change is intact", () => {
    const check = checkIntact(
      [
        { file: file("user"), read: ok(jevCopsSettings()) },
        { file: file("project"), read: ok({ permissions: { allow: ["Read"] } }) },
      ],
      id,
    );
    expect(check).toEqual({
      intact: true,
      why: "the cops hook is registered on every required event",
    });
  });

  test("the block removed from the only file that had it: not intact", () => {
    const check = checkIntact([{ file: file("user"), read: ok({ hooks: {} }) }], id);
    expect(check.intact).toBe(false);
    expect(check.why).toContain("PreToolUse");
  });

  test("still in another file: intact (the gate runs)", () => {
    const check = checkIntact(
      [
        { file: file("user"), read: ok({}) },
        { file: file("local"), read: ok(jevCopsSettings()) },
      ],
      id,
    );
    expect(check.intact).toBe(true);
  });

  test("the ConfigChange entry alone removed: not intact (the next change would go unseen)", () => {
    const s = jevCopsSettings();
    const { ConfigChange: _gone, ...rest } = s.hooks as Json;
    expect(checkIntact([{ file: file("user"), read: ok({ hooks: rest }) }], id)).toMatchObject({
      intact: false,
      why: expect.stringContaining("ConfigChange"),
    });
  });

  test("disableAllHooks in any non-managed file disables a non-managed install", () => {
    const check = checkIntact(
      [
        { file: file("user"), read: ok(jevCopsSettings()) },
        { file: file("local"), read: ok({ disableAllHooks: true }) },
      ],
      id,
    );
    expect(check).toMatchObject({ intact: false, why: expect.stringContaining("disableAllHooks") });
  });

  test("a managed install survives disableAllHooks outside managed settings", () => {
    const check = checkIntact(
      [
        { file: file("managed"), read: ok(jevCopsSettings()) },
        { file: file("user"), read: ok({ disableAllHooks: true }) },
      ],
      id,
    );
    expect(check.intact).toBe(true);
  });

  test("managed disableAllHooks, or allowManagedHooksOnly over a user install: not intact", () => {
    const managedOff = checkIntact(
      [{ file: file("managed"), read: ok(jevCopsSettings({ disableAllHooks: true })) }],
      id,
    );
    expect(managedOff.intact).toBe(false);
    const onlyManaged = checkIntact(
      [
        { file: file("managed"), read: ok({ allowManagedHooksOnly: true }) },
        { file: file("user"), read: ok(jevCopsSettings()) },
      ],
      id,
    );
    expect(onlyManaged).toMatchObject({
      intact: false,
      why: expect.stringContaining("allowManagedHooksOnly"),
    });
  });

  test("a changed file that is not valid JSON: not intact", () => {
    const check = checkIntact(
      [
        { file: file("user"), read: ok(jevCopsSettings()) },
        { file: file("project"), read: { kind: "invalid", error: "Unexpected token" } },
      ],
      id,
      "/project.json",
    );
    expect(check).toMatchObject({ intact: false, why: expect.stringContaining("not valid JSON") });
  });

  test("nothing installed anywhere: not intact", () => {
    expect(checkIntact([{ file: file("user"), read: MISSING }], id).intact).toBe(false);
  });
});
