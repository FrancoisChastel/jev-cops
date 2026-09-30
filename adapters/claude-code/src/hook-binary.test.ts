import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { HOOK_SOURCE } from "../testing/setup.ts";
import {
  defaultHookBinary,
  hookBinaryProblem,
  hookBinaryVersion,
  isRootLocked,
  isSharedWritable,
  isWritableByMe,
  OWN_HOOK_ENTRY,
} from "./hook-binary.ts";
import { type SpawnRequest, spawnProcess } from "./spawn.ts";
import { HOOK_VERSION } from "./version.ts";

let dir = "";
beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "jvcc-bin-")));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function script(name: string, body: string, mode = 0o755): string {
  const path = join(dir, name);
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, mode);
  return path;
}

describe("defaultHookBinary: dist/cops-hook next to cops, else cops-hook on PATH", () => {
  test("compiled cops: the sibling cops-hook", () => {
    const hook = script("cops-hook", "exit 0");
    const runtime = { execPath: join(dir, "cops"), main: "/$bunfs/root/cops" };
    expect(defaultHookBinary(runtime, "")).toBe(hook);
  });

  test("from source: the repo's dist/cops-hook", () => {
    mkdirSync(join(dir, "dist"));
    mkdirSync(join(dir, "packages", "cli", "src"), { recursive: true });
    writeFileSync(join(dir, "dist", "cops-hook"), "");
    const runtime = { execPath: "/usr/bin/bun", main: join(dir, "packages/cli/src/main.ts") };
    expect(defaultHookBinary(runtime, "")).toBe(join(dir, "dist", "cops-hook"));
  });

  test("from the jev-cops package: the cops-hook bin next to the running cops bin", () => {
    const bin = join(dir, "node_modules", "jev-cops", "bin");
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, "cops-hook.ts"), "");
    const runtime = { execPath: "/usr/bin/bun", main: join(bin, "cops.ts") };
    expect(defaultHookBinary(runtime, "", "/nowhere/hook-main.ts")).toBe(join(bin, "cops-hook.ts"));
  });

  test("@jev-cops/cli installed alone: this adapter's own bin, only under node_modules", () => {
    const own = join(
      dir,
      "node_modules",
      "@jev-cops",
      "adapter-claude-code",
      "src",
      "hook-main.ts",
    );
    mkdirSync(dirname(own), { recursive: true });
    writeFileSync(own, "");
    const cli = join(dir, "node_modules", "@jev-cops", "cli", "src", "main.ts");
    const runtime = { execPath: "/usr/bin/bun", main: cli };
    expect(defaultHookBinary(runtime, "", own)).toBe(own);
    // In a source checkout the adapter's file is not a hook anyone installed: PATH decides.
    expect(OWN_HOOK_ENTRY).not.toContain("node_modules");
    expect(defaultHookBinary(runtime, "/nonexistent", OWN_HOOK_ENTRY)).toBeNull();
  });

  test("otherwise cops-hook on PATH, else null", () => {
    const bin = join(dir, "bin");
    mkdirSync(bin);
    writeFileSync(join(bin, "cops-hook"), "#!/bin/sh\n");
    chmodSync(join(bin, "cops-hook"), 0o755);
    const runtime = { execPath: "/nowhere/cops", main: "/$bunfs/root/cops" };
    expect(defaultHookBinary(runtime, `/nonexistent:${bin}`)).toBe(join(bin, "cops-hook"));
    expect(defaultHookBinary(runtime, "/nonexistent")).toBeNull();
  });
});

describe("hookBinaryProblem (PLAN-M1 §5 row 1: a missing binary silently disables the gate)", () => {
  test("an executable file is fine", () => {
    expect(hookBinaryProblem(script("cops-hook", "exit 0"))).toBeNull();
  });

  test.each([
    ["relative", () => "cops-hook", "absolute"],
    ["missing", () => join(dir, "gone"), "does not exist"],
    ["a directory", () => dir, "not a file"],
    ["not executable", () => script("cops-hook", "exit 0", 0o644), "not executable"],
  ])("%s", (_why, path, message) => {
    expect(hookBinaryProblem(path())).toContain(message);
  });

  test("isSharedWritable: a group or world write bit (Bun installs bins 0777)", () => {
    expect(isSharedWritable(script("open", "exit 0", 0o777))).toBe(true);
    expect(isSharedWritable(script("group", "exit 0", 0o775))).toBe(true);
    expect(isSharedWritable(script("mine", "exit 0", 0o755))).toBe(false);
    expect(isSharedWritable(join(dir, "missing"))).toBe(false);
  });

  test("isWritableByMe", () => {
    expect(isWritableByMe(script("w", "exit 0"))).toBe(true);
    expect(isWritableByMe(join(dir, "missing"))).toBe(false);
  });

  test("isRootLocked: root-owned and not group/world writable", () => {
    expect(isRootLocked("/bin/sh")).toBe(true);
    expect(isRootLocked(script("mine", "exit 0"))).toBe(false);
    expect(isRootLocked(join(dir, "missing"))).toBe(false);
  });
});

describe("hookBinaryVersion", () => {
  const env = { PATH: "/usr/bin:/bin" };
  test("the real hook from source prints HOOK_VERSION", async () => {
    const run = (r: SpawnRequest) =>
      spawnProcess({ ...r, argv: [process.execPath, HOOK_SOURCE, ...r.argv.slice(1)] });
    expect(await hookBinaryVersion("/unused", run, env)).toEqual({
      version: HOOK_VERSION,
      error: null,
    });
  });

  test("a binary that fails or prints nothing has no version", async () => {
    expect(
      (await hookBinaryVersion(script("bad", "exit 3"), spawnProcess, env)).version,
    ).toBeNull();
    const silent = await hookBinaryVersion(script("silent", "exit 0"), spawnProcess, env);
    expect(silent).toEqual({ version: null, error: "printed no version" });
  });
});
