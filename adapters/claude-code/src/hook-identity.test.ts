import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  commandFile,
  entrySelf,
  isBunExecutable,
  isCompiledMain,
  namedProgram,
  realpathOrNull,
  selfFlags,
  selfOf,
} from "./hook-identity.ts";

let dir = "";
let bun = "";
let script = "";
let binary = "";
let ctx = { projectDir: "", path: "" };
const FLAGS = ["--harness", "claude-code", "--socket", "/run/j.sock"];

function file(path: string, body: string, mode = 0o755): string {
  writeFileSync(path, body);
  chmodSync(path, mode);
  return path;
}

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "jvcc-id-")));
  mkdirSync(join(dir, "bin"));
  bun = file(join(dir, "bin", "bun"), "\x7fELF bun\n");
  script = file(join(dir, "cops-hook.ts"), "#!/usr/bin/env bun\nprocess.exitCode = 2;\n");
  binary = file(join(dir, "cops-hook"), "\xcf\xfa\xed\xfe compiled\n");
  ctx = { projectDir: dir, path: join(dir, "bin") };
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("selfOf: this process as a hook", () => {
  test("from source: the entry script, run by this Bun", () => {
    expect(selfOf(["hook"], { execPath: "/usr/bin/bun", main: "/repo/cli/main.ts" })).toEqual({
      program: "/repo/cli/main.ts",
      runtime: "/usr/bin/bun",
      leading: ["hook"],
    });
  });

  test("compiled: the binary alone", () => {
    expect(selfOf([], { execPath: "/opt/cops-hook", main: "/$bunfs/root/cops-hook" })).toEqual({
      program: "/opt/cops-hook",
      runtime: null,
      leading: [],
    });
    expect(isCompiledMain("B:/~BUN/root/cops-hook.exe")).toBe(true);
    expect(isCompiledMain("/repo/hook-main.ts")).toBe(false);
  });

  test("defaults to this process", () => {
    expect(selfOf([])).toEqual({ program: Bun.main, runtime: process.execPath, leading: [] });
  });
});

describe("selfFlags: an entry that starts this hook, and what it passes it", () => {
  const scriptSelf = () => ({ program: script, runtime: bun, leading: [] });

  test("a script started directly (its #! line), by path or through a symlink", () => {
    expect(selfFlags(script, FLAGS, scriptSelf(), ctx)).toEqual(FLAGS);
    const link = join(dir, "bin", "cops-hook");
    symlinkSync(script, link);
    expect(selfFlags(link, FLAGS, scriptSelf(), ctx)).toEqual(FLAGS);
    expect(selfFlags("cops-hook", FLAGS, scriptSelf(), ctx)).toEqual(FLAGS);
  });

  test("the same script through the same Bun", () => {
    expect(selfFlags(bun, [script, ...FLAGS], scriptSelf(), ctx)).toEqual(FLAGS);
    expect(selfFlags("bun", ["./cops-hook.ts", ...FLAGS], scriptSelf(), ctx)).toEqual(FLAGS);
  });

  test("a compiled binary: only itself", () => {
    const self = { program: binary, runtime: null, leading: [] };
    expect(selfFlags(binary, FLAGS, self, ctx)).toEqual(FLAGS);
    expect(selfFlags(bun, [binary, ...FLAGS], self, ctx)).toBeNull();
  });

  test("leading arguments must be there (cops hook)", () => {
    const self = { program: script, runtime: bun, leading: ["hook"] };
    expect(selfFlags(script, ["hook", ...FLAGS], self, ctx)).toEqual(FLAGS);
    expect(selfFlags(script, FLAGS, self, ctx)).toBeNull();
    expect(selfFlags(script, [], self, ctx)).toBeNull();
  });

  test.each([
    ["another script", () => [file(join(dir, "other.ts"), "#!/usr/bin/env bun\n"), FLAGS]],
    ["another Bun", () => [file(join(dir, "bun2"), "bun\n"), [script, ...FLAGS]]],
    ["Bun with another script", () => [bun, [binary, ...FLAGS]]],
    ["Bun with no script", () => [bun, []]],
    ["a missing command", () => [join(dir, "gone"), FLAGS]],
    ["a name not on PATH", () => ["nowhere-hook", FLAGS]],
    [
      "a wrapper that execs the hook",
      () => [file(join(dir, "wrap"), `#!/bin/sh\nexec "${script}" "$@"\n`), FLAGS],
    ],
  ] as const)("not %s", (_name, entry) => {
    const [command, args] = entry() as [string, string[]];
    expect(selfFlags(command, args, scriptSelf(), ctx)).toBeNull();
  });

  test("a hook whose own program is gone matches nothing", () => {
    const self = { program: join(dir, "gone.ts"), runtime: bun, leading: [] };
    expect(selfFlags(script, FLAGS, self, ctx)).toBeNull();
  });
});

describe("entrySelf: the identity the hook an entry starts will compute", () => {
  test("a script started directly: itself, run by the Bun its #! line finds on PATH", () => {
    expect(entrySelf(script, FLAGS, ctx)).toEqual({
      self: { program: script, runtime: bun, leading: [] },
      flags: FLAGS,
    });
  });

  test("an absolute #! bun, a foreign interpreter, a compiled binary", () => {
    const abs = file(join(dir, "abs.ts"), `#!${bun}\n`);
    expect(entrySelf(abs, FLAGS, ctx)?.self.runtime).toBe(bun);
    const node = file(join(dir, "node.js"), "#!/usr/bin/env node\n");
    expect(entrySelf(node, FLAGS, ctx)?.self.runtime).toBeNull();
    const envBunMissing = { ...ctx, path: "/nonexistent" };
    expect(entrySelf(script, FLAGS, envBunMissing)?.self.runtime).toBeNull();
    expect(entrySelf(binary, FLAGS, ctx)?.self).toEqual({
      program: binary,
      runtime: null,
      leading: [],
    });
  });

  test("bun <script> [hook]: the script, this Bun, the leading arguments", () => {
    expect(entrySelf("bun", [script, "hook", ...FLAGS], ctx)).toEqual({
      self: { program: script, runtime: bun, leading: ["hook"] },
      flags: FLAGS,
    });
  });

  test("the prediction is what the hook matches against: entrySelf ∘ selfFlags", () => {
    for (const [command, args] of [
      [script, FLAGS],
      [bun, [script, ...FLAGS]],
      [binary, FLAGS],
      [script, ["hook", ...FLAGS]],
    ] as const) {
      const predicted = entrySelf(command, args, ctx);
      expect(predicted).not.toBeNull();
      if (predicted === null) continue;
      expect(selfFlags(command, args, predicted.self, ctx)).toEqual(predicted.flags);
    }
  });

  test("nothing to predict: a missing command or script", () => {
    expect(entrySelf(join(dir, "gone"), FLAGS, ctx)).toBeNull();
    expect(entrySelf(bun, [join(dir, "gone.ts"), ...FLAGS], ctx)).toBeNull();
    expect(entrySelf(script, [], ctx)).toEqual({
      self: { program: script, runtime: bun, leading: [] },
      flags: [],
    });
  });

  test("an unreadable script predicts no runtime", () => {
    const locked = file(join(dir, "locked.ts"), "#!/usr/bin/env bun\n", 0o000);
    expect(entrySelf(locked, FLAGS, ctx)?.self.runtime ?? null).toBeNull();
  });
});

describe("helpers", () => {
  test("commandFile: placeholder, relative paths, PATH, symlinks", () => {
    // biome-ignore lint/suspicious/noTemplateCurlyInString: Claude Code's literal placeholder
    expect(commandFile("${CLAUDE_PROJECT_DIR}/cops-hook.ts", ctx)).toBe(script);
    expect(commandFile("./cops-hook.ts", ctx)).toBe(script);
    expect(commandFile("bun", ctx)).toBe(bun);
    expect(commandFile("nope", ctx)).toBeNull();
  });

  test("realpathOrNull, isBunExecutable, namedProgram", () => {
    expect(realpathOrNull(null)).toBeNull();
    expect(realpathOrNull("")).toBeNull();
    expect(realpathOrNull(join(dir, "gone"))).toBeNull();
    expect(isBunExecutable("/x/bun")).toBe(true);
    expect(isBunExecutable("C:/x/BUN.EXE")).toBe(true);
    expect(isBunExecutable("/x/bunx")).toBe(false);
    expect(namedProgram("/x/bun", ["/r/hook-main.ts", "--harness"])).toBe("/r/hook-main.ts");
    expect(namedProgram("/x/bun", [])).toBe("/x/bun");
    expect(namedProgram("/x/cops-hook.ts", ["--harness"])).toBe("/x/cops-hook.ts");
  });
});
