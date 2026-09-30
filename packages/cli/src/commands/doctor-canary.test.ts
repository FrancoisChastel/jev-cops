/**
 * `cops doctor`'s offline canary: the adapter's `runOfflineCanary` (the one shared with
 * `cops install claude-code`) run through the registered hook with the doctor's process
 * runner, and each probe rendered as a check. Classification is tested in the adapter
 * (adapters/claude-code/src/canary.test.ts); these tests pin the doctor's statuses and words.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import type { CanaryProbe, CanaryResult } from "@jev-cops/adapter-claude-code";
import { hookCommand } from "../../../../adapters/claude-code/testing/setup.ts";
import { startTestDaemon, type TestDaemon } from "../../../daemon/src/testing/daemon.ts";
import { type DoctorFixture, doctorFixture, executable, REPO_POLICIES } from "../testing/doctor.ts";
import {
  BENIGN_CASE,
  type CanaryHook,
  CONFIG_WRITE_CASE,
  canaryChecks,
  type DoctorCanaryOptions,
  doctorCanary,
} from "./doctor-canary.ts";
import { spawnProcess } from "./doctor-process.ts";
import type { ProcessRequest } from "./doctor-types.ts";

let enforce: TestDaemon;
let observe: TestDaemon;
let f: DoctorFixture;

beforeAll(async () => {
  enforce = await startTestDaemon({ policies: {}, policiesDir: REPO_POLICIES });
  observe = await startTestDaemon({ policies: {}, policiesDir: REPO_POLICIES, mode: "observe" });
});
afterAll(async () => {
  await enforce.stop();
  await observe.stop();
});
beforeEach(() => {
  f = doctorFixture();
});
afterEach(() => f.dispose());

function options(hook: CanaryHook, td: TestDaemon): DoctorCanaryOptions {
  return {
    hook,
    home: f.home,
    daemonHome: td.config.daemon.home,
    cwd: f.project,
    env: { PATH: f.bin, HOME: f.home },
    run: spawnProcess,
  };
}

describe("doctor offline canary: the registered hook, spawned as Claude Code would", () => {
  test("enforce: the config write is killed (exit 2, deny, continue:false), a benign call proceeds", async () => {
    const hook = hookCommand(enforce.config.daemon.socket);
    const result = await doctorCanary(options(hook, enforce));
    expect(result.status).toBe("ok");
    const checks = canaryChecks(result, hook);
    expect(checks.map((c) => [c.group, c.name, c.status])).toEqual([
      ["canary", BENIGN_CASE, "ok"],
      ["canary", CONFIG_WRITE_CASE, "ok"],
    ]);
    expect(checks[1]?.detail).toContain("observed exit 2, deny, continue:false");
    expect(checks[1]?.detail).toContain("config-tamper killed the write");
    const judged = enforce.audit().filter((l) => l.kind === "judge");
    const sessions = judged.map((l) => String(l.session_id));
    expect(sessions.some((s) => s.startsWith("sess_jev-cops-canary-write-"))).toBe(true);
  });

  test("the write targets copsd's home, the hook runs with the user's HOME in the project", async () => {
    const requests: ProcessRequest[] = [];
    const run = async (r: ProcessRequest) => {
      requests.push(r);
      return spawnProcess(r);
    };
    const hook = hookCommand(enforce.config.daemon.socket);
    await doctorCanary({ ...options(hook, enforce), run });
    expect(requests.map((r) => [r.cwd, r.env.HOME, r.env.PATH])).toEqual([
      [f.project, f.home, f.bin],
      [f.project, f.home, f.bin],
    ]);
    const write = JSON.parse(requests[1]?.stdin ?? "{}") as { tool_input: { file_path: string } };
    expect(write.tool_input.file_path).toBe(
      join(enforce.config.daemon.home, ".claude", "settings.json"),
    );
    expect(requests[0]?.timeoutMs).toBe(30_000); // Claude Code's default PreToolUse timeout
  });

  test("observe: the hook cannot block, by design: a warning, not a failure", async () => {
    const hook = hookCommand(observe.config.daemon.socket);
    const result = await doctorCanary(options(hook, observe));
    expect(result.status).toBe("observe");
    const [benign, write] = canaryChecks(result, hook);
    expect(write?.status).toBe("warn");
    expect(write?.detail).toContain("observed exit 0, additionalContext");
    expect(write?.detail).toContain("enforcement observe: the hook cannot block, by design");
    expect(benign?.status).toBe("ok");
  });

  test("a hook replaced by a no-op (/bin/true-like): the config write gets through, gate silently disabled", async () => {
    const hook = {
      command: executable(f.bin, "cops-hook", "exit 0"),
      args: ["--harness", "claude-code"],
    };
    const result = await doctorCanary(options(hook, enforce));
    expect(result.status).toBe("failed");
    const [benign, write] = canaryChecks(result, hook);
    expect(write?.status).toBe("fail");
    expect(write?.detail).toContain("via cops-hook: expected exit 2, deny, continue:false");
    expect(write?.detail).toContain("gate silently disabled");
    expect(benign?.status).toBe("ok");
  });

  test("a hook that cannot start or hangs past its registered timeout fails", async () => {
    const missing = { command: join(f.root, "nope"), args: [] };
    const gone = await doctorCanary(options(missing, enforce));
    expect(gone.probes.map((p) => p.observed)).toEqual(["did not start", "did not start"]);
    const [, goneWrite] = canaryChecks(gone, missing);
    expect(goneWrite?.status).toBe("fail");
    expect(goneWrite?.detail).toContain("did not block as expected");
    const slow = {
      command: executable(f.bin, "slow", "exec /bin/sleep 5"),
      args: [],
      timeoutS: 0.3,
    };
    const hung = await doctorCanary(options(slow, enforce));
    expect(hung.status).toBe("failed");
    expect(hung.probes[0]?.observed).toBe("timed out");
    expect(canaryChecks(hung, slow)[0]?.detail).toContain("timed out");
  });
});

describe("canaryChecks: statuses and words for every outcome", () => {
  const hook = { command: "/opt/jev-cops/cops-hook", args: [] };
  const probe = (p: Partial<CanaryProbe>): CanaryProbe => ({
    name: "config-write",
    expected: "exit 2, deny, continue:false",
    observed: "exit 2, judge unreachable",
    outcome: "unreachable",
    exitCode: 2,
    stdout: "",
    stderr: "jev-cops: judge unreachable (connect ENOENT); blocking (fail closed)\nmore",
    ...p,
  });
  const result = (probes: CanaryProbe[]): CanaryResult => ({
    status: "unreachable",
    detail: "",
    probes,
  });

  test("unreachable: fail with a hint (the hook fails closed on every non-read call)", () => {
    const [c] = canaryChecks(result([probe({})]), hook);
    expect(c?.status).toBe("fail");
    expect(c?.detail).toContain("could not reach copsd (jev-cops: judge unreachable");
    expect(c?.detail).not.toContain("more");
    expect(c?.detail).toContain("start copsd");
  });

  test("a failed benign call and a failure without stderr", () => {
    const benign = probe({ name: "benign-bash", outcome: "failed", stderr: "boom" });
    const quiet = probe({ outcome: "failed", exitCode: 1, stderr: "" });
    const [b, q] = canaryChecks(result([benign, quiet]), hook);
    expect(b).toMatchObject({ name: BENIGN_CASE, status: "fail" });
    expect(b?.detail).toContain("A benign call did not pass cleanly (boom)");
    expect(q?.detail).toMatch(/gate silently disabled$/);
  });
});
