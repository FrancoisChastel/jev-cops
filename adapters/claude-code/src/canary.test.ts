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
