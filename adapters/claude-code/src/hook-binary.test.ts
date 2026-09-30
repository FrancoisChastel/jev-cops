import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HOOK_SOURCE } from "../testing/setup.ts";
import {
  defaultHookBinary,
  hookBinaryProblem,
  hookBinaryVersion,
  isWritableByMe,
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

  test("isWritableByMe", () => {
    expect(isWritableByMe(script("w", "exit 0"))).toBe(true);
    expect(isWritableByMe(join(dir, "missing"))).toBe(false);
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
