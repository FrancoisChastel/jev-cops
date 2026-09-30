import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { copyFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { HOOK_VERSION } from "@jev-cops/adapter-claude-code";
import { CLI_VERSION } from "../cli/src/version.ts";
import { DAEMON_VERSION } from "../daemon/src/daemon.ts";
import manifest from "./package.json" with { type: "json" };

/**
 * The `jev-cops` package's bins, run as the installed ones are: `bun <bin>` from outside the
 * repository, with a scratch HOME. The pack smoke test (`bun run pack:smoke`) runs them from
 * a real global install of the packed tarballs.
 */
const BIN = join(import.meta.dir, "bin");
const BUN_PATH = `${dirname(process.execPath)}:/usr/bin:/bin`;
let dir: string;

beforeAll(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "jev-cops-bins-")));
  mkdirSync(join(dir, "home"));
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

async function run(argv: string[]): Promise<{ code: number; out: string; err: string }> {
  const proc = Bun.spawn([process.execPath, ...argv], {
    cwd: dir,
    env: { PATH: BUN_PATH, HOME: join(dir, "home") },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [code, out, err] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { code, out, err };
}

describe("jev-cops bins", () => {
  test("the manifest names exactly the three bins, all in this directory", () => {
    expect(manifest.bin).toEqual({
      cops: "./bin/cops.ts",
      copsd: "./bin/copsd.ts",
      "cops-hook": "./bin/cops-hook.ts",
    });
    expect(manifest.version).toBe(CLI_VERSION);
  });

  test("cops --version and copsd --help report the package version", async () => {
    const cops = await run([join(BIN, "cops.ts"), "--version"]);
    expect(cops).toMatchObject({ code: 0, out: `${CLI_VERSION}\n` });
    const copsd = await run([join(BIN, "copsd.ts"), "--help"]);
    expect(copsd.code).toBe(0);
    expect(copsd.out).toStartWith(`copsd ${DAEMON_VERSION} `);
  });

  test("cops-hook --version is the version cops install checks", async () => {
    const hook = await run([join(BIN, "cops-hook.ts"), "--version"]);
    expect(hook).toMatchObject({ code: 0, out: `${HOOK_VERSION}\n` });
  });

  test("a cops-hook that cannot load its runtime blocks (exit 2), never exits 1", async () => {
    const orphan = join(dir, "orphan", "cops-hook.ts");
    mkdirSync(dirname(orphan));
    copyFileSync(join(BIN, "cops-hook.ts"), orphan);
    const hook = await run([orphan, "--harness", "claude-code"]);
    expect(hook.code).toBe(2);
    expect(hook.err).toContain("hook failed to start");
    expect(hook.err).toContain("blocking (fail closed)");
  });

  test("cops install claude-code registers the cops-hook bin next to cops", async () => {
    const home = join(dir, "home");
    const argv = [join(BIN, "cops.ts"), "install", "claude-code", "--home", home, "--dry-run"];
    const r = await run([...argv, "--socket", join(dir, "d.sock")]);
    expect(r.err).toBe("");
    expect(r.code).toBe(0);
    expect(r.out).toContain(`hook ${join(BIN, "cops-hook.ts")} (version ${CLI_VERSION})`);
  });
});
