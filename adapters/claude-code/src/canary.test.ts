/**
 * The offline canary against a real copsd running the repo's policies (config-tamper kills
 * the settings write), with the hook run from source exactly as an install registers it.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startTestDaemon, type TestDaemon } from "../../../packages/daemon/src/testing/daemon.ts";
import { hookCommand } from "../testing/setup.ts";
import {
  CANARY_DEFAULT_TIMEOUT_MS,
  canaryPayloads,
  describeHookRun,
  registeredPreToolUse,
  runOfflineCanary,
} from "./canary.ts";
import { jevCopsHookEntries } from "./hook-entries.ts";
import { mergeHooks } from "./settings-merge.ts";
import type { SpawnRequest, SpawnResult } from "./spawn.ts";

const REPO_POLICIES = join(import.meta.dir, "..", "..", "..", "policies");
let root = "";
let home = "";
let enforce: TestDaemon;
let observe: TestDaemon;

beforeAll(async () => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "jvcc-can-")));
  home = join(root, "home");
  mkdirSync(home);
  enforce = await startTestDaemon({ policies: {}, policiesDir: REPO_POLICIES, mode: "enforce" });
  observe = await startTestDaemon({ policies: {}, policiesDir: REPO_POLICIES, mode: "observe" });
}, 30_000);
afterAll(async () => {
  await enforce.stop();
  await observe.stop();
  rmSync(root, { recursive: true, force: true });
});

const env = { PATH: process.env.PATH ?? "/usr/bin:/bin" };

describe("runOfflineCanary (PLAN-M1 §4.4, D-078 proposal)", () => {
  test("enforce: the settings write is killed (exit 2, continue:false) and `true` runs", async () => {
    const r = await runOfflineCanary({
      hook: hookCommand(enforce.config.daemon.socket),
      home,
      env,
    });
    expect(r.status).toBe("ok");
    expect(r.probes.map((p) => [p.name, p.outcome])).toEqual([
      ["benign-bash", "ok"],
      ["config-write", "ok"],
    ]);
    expect(r.probes[1]?.exitCode).toBe(2);
  }, 30_000);

  test("observe: reported, not blocked", async () => {
    const r = await runOfflineCanary({
      hook: hookCommand(observe.config.daemon.socket),
      home,
      env,
    });
    expect(r.status).toBe("observe");
    expect(r.detail).toContain("observe");
  }, 30_000);

  test("daemon down: the fail-closed warning, not a failure", async () => {
    const r = await runOfflineCanary({ hook: hookCommand(join(root, "none.sock")), home, env });
    expect(r.status).toBe("unreachable");
    expect(r.detail).toBe(
      "daemon not reachable: the hook will block every non-read call until copsd runs (fail closed)",
    );
  }, 30_000);

  test("a hook that lets everything through fails (gate silently disabled)", async () => {
    const fake = join(root, "true-hook");
    writeFileSync(fake, "#!/bin/sh\ncat >/dev/null\nexit 0\n");
    chmodSync(fake, 0o755);
    const r = await runOfflineCanary({ hook: { command: fake, args: [] }, home, env });
    expect(r.status).toBe("failed");
    expect(r.detail).toContain("config-write");
    expect(r.probes[1]).toMatchObject({ outcome: "failed", observed: "exit 0, no output" });
  }, 30_000);

  test("the write probe targets copsd's home (targetHome), not the hook's HOME", async () => {
    // cwd outside `home`: `<home>/.claude/settings.json` is neither copsd's user settings nor
    // a project settings file of the cwd, so config-tamper would let the write through.
    const cwd = join(root, "elsewhere");
    mkdirSync(cwd, { recursive: true });
    const hook = hookCommand(enforce.config.daemon.socket);
    const wrong = await runOfflineCanary({ hook, home, cwd, env });
    expect(wrong.status).toBe("failed");
    const target = enforce.config.daemon.home;
    const r = await runOfflineCanary({ hook, home, targetHome: target, cwd, env });
    expect(r.status).toBe("ok");
    const write = JSON.parse(canaryPayloads(target, cwd, "n").write) as {
      tool_input: { file_path: string };
    };
    expect(write.tool_input.file_path).toBe(join(target, ".claude", "settings.json"));
  }, 30_000);

  test("each probe says what the hook did, in the vocabulary of what was expected", async () => {
    const r = await runOfflineCanary({
      hook: hookCommand(enforce.config.daemon.socket),
      home,
      env,
    });
    expect(r.probes.map((p) => [p.expected, p.observed])).toEqual([
      ["exit 0, no output", "exit 0, no output"],
      [
        "exit 2, deny, continue:false (observe mode: exit 0, additionalContext)",
        "exit 2, deny, continue:false",
      ],
    ]);
    const observed = await runOfflineCanary({
      hook: hookCommand(observe.config.daemon.socket),
      home,
      env,
    });
    expect(observed.probes[1]?.observed).toBe("exit 0, additionalContext");
  }, 30_000);
});

describe("canary classification (stubbed spawn)", () => {
  const stub =
    (answers: Partial<SpawnResult>[]) =>
    async (_r: SpawnRequest): Promise<SpawnResult> => ({
      exitCode: 0,
      stdout: "",
      stderr: "",
      timedOut: false,
      error: null,
      ...(answers.shift() ?? {}),
    });
  const hook = { command: "/x/cops-hook", args: [] };

  test("a hook that cannot start fails", async () => {
    const spawn = stub([
      { exitCode: null, error: "ENOENT" },
      { exitCode: null, error: "ENOENT" },
    ]);
    const r = await runOfflineCanary({ hook, home, env, spawn });
    expect(r.status).toBe("failed");
    expect(r.detail).toContain("ENOENT");
  });

  test("a judge timeout counts as unreachable", async () => {
    const late = { exitCode: 2, stderr: "jev-cops: judge timeout; blocking (fail closed)" };
    const r = await runOfflineCanary({ hook, home, env, spawn: stub([late, late]) });
    expect(r.status).toBe("unreachable");
  });

  test("a deny without continue:false is not the kill the canary expects", async () => {
    const deny = JSON.stringify({ hookSpecificOutput: { permissionDecision: "deny" } });
    const r = await runOfflineCanary({
      hook,
      home,
      env,
      spawn: stub([{}, { exitCode: 2, stdout: deny }]),
    });
    expect(r.status).toBe("failed");
  });

  test("defaults", () => {
    expect(CANARY_DEFAULT_TIMEOUT_MS).toBeGreaterThan(13_000);
  });

  test("a hook killed at the deadline fails; the caller's deadline is the one used", async () => {
    const seen: number[] = [];
    const spawn = async (r: SpawnRequest): Promise<SpawnResult> => {
      seen.push(r.timeoutMs);
      return { exitCode: null, stdout: "", stderr: "", timedOut: true, error: null };
    };
    const r = await runOfflineCanary({ hook, home, env, spawn, timeoutMs: 30_000 });
    expect(seen).toEqual([30_000, 30_000]);
    expect(r.status).toBe("failed");
    expect(r.probes.map((p) => p.observed)).toEqual(["timed out", "timed out"]);
    expect(r.probes[0]?.stderr).toBe("timed out");
  });

  test("the hook gets HOME and PATH only, in the cwd, with the payload on stdin", async () => {
    const requests: SpawnRequest[] = [];
    const spawn = async (req: SpawnRequest): Promise<SpawnResult> => {
      requests.push(req);
      return { exitCode: 0, stdout: "", stderr: "", timedOut: false, error: null };
    };
    const secretEnv = { PATH: "/p", ANTHROPIC_API_KEY: "sk-x", CLAUDE_CONFIG_DIR: "/c" };
    await runOfflineCanary({ hook, home, cwd: "/w", env: secretEnv, spawn, nonce: "n1" });
    expect(requests.map((q) => q.env)).toEqual([
      { PATH: "/p", HOME: home },
      { PATH: "/p", HOME: home },
    ]);
    expect(requests.map((q) => q.cwd)).toEqual(["/w", "/w"]);
    expect(JSON.parse(requests[0]?.stdin ?? "{}")).toMatchObject({
      session_id: "jev-cops-canary-bash-n1",
      cwd: "/w",
    });
  });
});

describe("describeHookRun: a run as Claude Code reads it", () => {
  const base = { exitCode: 0, stderr: "", timedOut: false, error: null };
  test.each([
    [{ ...base, stdout: "" }, "exit 0, no output"],
    [{ ...base, stdout: "hello" }, "exit 0, non-JSON output"],
    [{ ...base, stdout: '{"a":1}' }, "exit 0, other JSON"],
    [{ ...base, stdout: "[1]" }, "exit 0, non-JSON output"],
    [
      { ...base, stdout: '{"hookSpecificOutput":{"permissionDecision":"ask","updatedInput":{}}}' },
      "exit 0, ask, updatedInput",
    ],
    [
      {
        ...base,
        exitCode: 2,
        stdout: '{"continue":false,"hookSpecificOutput":{"permissionDecision":"deny"}}',
      },
      "exit 2, deny, continue:false",
    ],
    [{ ...base, exitCode: null, error: "ENOENT" }, "did not start"],
    [{ ...base, exitCode: null, timedOut: true }, "timed out"],
  ])("%j → %s", (run, text) => {
    expect(describeHookRun({ stdout: "", ...run })).toBe(text);
  });
});

describe("canaryPayloads and registeredPreToolUse", () => {
  test("two PreToolUse payloads with throw-away sessions", () => {
    const p = canaryPayloads(home, home, "abc");
    const benign = JSON.parse(p.benign) as Record<string, unknown>;
    const write = JSON.parse(p.write) as Record<string, unknown>;
    expect(benign).toMatchObject({ tool_name: "Bash", tool_input: { command: "true" }, cwd: home });
    expect(write).toMatchObject({
      tool_name: "Write",
      tool_input: { file_path: join(home, ".claude", "settings.json") },
    });
    expect(benign.session_id).not.toBe(write.session_id);
  });

  test("the PreToolUse handler exactly as a settings object registers it", () => {
    const entries = jevCopsHookEntries("/opt/cops-hook", "/s.sock");
    const settings = mergeHooks(
      { hooks: { PreToolUse: [{ hooks: [{ type: "command", command: "/x" }] }] } },
      entries,
    );
    expect(registeredPreToolUse(settings, "/opt/cops-hook")).toEqual({
      command: "/opt/cops-hook",
      args: ["--harness", "claude-code", "--socket", "/s.sock"],
    });
    expect(registeredPreToolUse({}, "/opt/cops-hook")).toBeNull();
    expect(registeredPreToolUse({ hooks: { PreToolUse: "x" } })).toBeNull();
  });
});
