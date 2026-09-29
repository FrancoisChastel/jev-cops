/**
 * The compiled `jevdict-hook` (D-079 proposal): a lean bundle (no tree-sitter, no WASM), its
 * cold start on a benign call, and one end-to-end run of the binary under the fake Claude
 * Code. Built into a temp directory, so the test never depends on `bun run build`.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startTestDaemon, type TestDaemon } from "../../packages/daemon/src/testing/daemon.ts";
import { FakeClaudeCode } from "./testing/fake-claude.ts";
import { spawnHook } from "./testing/hook-run.ts";
import { HOOK_SOURCE, hookCommand } from "./testing/setup.ts";

const REPO_POLICIES = join(import.meta.dir, "..", "..", "policies");
/** Loose on purpose: CI machines vary; the number itself is printed. */
const MAX_COLD_MS = 1_500;
const RUNS = 10;

let dir = "";
let binary = "";
let td: TestDaemon;

async function build(args: string[]): Promise<void> {
  const proc = Bun.spawn(["bun", "build", ...args], { stdout: "pipe", stderr: "pipe" });
  if ((await proc.exited) !== 0) throw new Error(await new Response(proc.stderr).text());
}

beforeAll(async () => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "jvcc-bin-")));
  mkdirSync(join(dir, "home"));
  binary = join(dir, "jevdict-hook");
  await build(["--compile", HOOK_SOURCE, "--outfile", binary]);
  await build([HOOK_SOURCE, "--target", "bun", "--outdir", join(dir, "bundle")]);
  td = await startTestDaemon({ policies: {}, policiesDir: REPO_POLICIES });
}, 60_000);

afterAll(async () => {
  await td.stop();
  rmSync(dir, { recursive: true, force: true });
});

const env = () => ({ PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: join(dir, "home") });

function benign(): string {
  return JSON.stringify({
    session_id: crypto.randomUUID(),
    cwd: dir,
    permission_mode: "default",
    hook_event_name: "PreToolUse",
    tool_name: "Bash",
    tool_input: { command: "ls" },
    tool_use_id: `toolu_${crypto.randomUUID().replaceAll("-", "")}`,
  });
}

describe("compiled jevdict-hook", () => {
  test("the bundle is lean: no tree-sitter grammar, no WASM, under 2 MB", () => {
    const bundle = join(dir, "bundle", "hook-main.js");
    const source = readFileSync(bundle, "utf8");
    expect(source).not.toContain("tree-sitter");
    expect(source).not.toContain(".wasm");
    expect(statSync(bundle).size).toBeLessThan(2_000_000);
  });

  test(`a benign call: exit 0, no output; cold start and p50 under ${MAX_COLD_MS} ms`, async () => {
    const hook = hookCommand(td.config.daemon.socket, binary);
    const opts = { env: env(), cwd: dir, timeoutS: 30, headless: false };
    const times: number[] = [];
    for (let i = 0; i < RUNS; i += 1) {
      const run = await spawnHook(hook, benign(), opts);
      expect({ code: run.exitCode, stdout: run.stdout, stderr: run.stderr }).toEqual({
        code: 0,
        stdout: "",
        stderr: "",
      });
      times.push(run.ms);
    }
    const cold = times[0] ?? Number.POSITIVE_INFINITY;
    const p50 = [...times].sort((a, b) => a - b)[Math.floor(RUNS / 2)] ?? cold;
    process.stderr.write(
      `jevdict-hook: cold ${cold.toFixed(0)} ms, p50 ${p50.toFixed(0)} ms over ${RUNS} runs (daemon allow)\n`,
    );
    expect(cold).toBeLessThan(MAX_COLD_MS);
    expect(p50).toBeLessThan(MAX_COLD_MS);
  }, 60_000);

  test("under the fake Claude Code: a config write is a kill (exit 2 + continue:false)", async () => {
    const c = new FakeClaudeCode({
      hooks: [hookCommand(td.config.daemon.socket, binary)],
      cwd: dir,
      env: env(),
    });
    const kill = await c.tool("Write", {
      file_path: join(dir, ".claude", "settings.json"),
      content: "{}",
    });
    expect(kill.decision).toMatchObject({ outcome: "deny", stop: true });
    expect((await c.tool("Bash", { command: "ls" })).result).toBe(
      "jevdict: session terminated by jevdict",
    );
  });
});
