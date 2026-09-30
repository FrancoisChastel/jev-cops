import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { hookCommand } from "../../../../adapters/claude-code/testing/setup.ts";
import { startTestDaemon, type TestDaemon } from "../../../daemon/src/testing/daemon.ts";
import { type DoctorFixture, doctorFixture, executable, REPO_POLICIES } from "../testing/doctor.ts";
import {
  BENIGN_CASE,
  type CanaryHook,
  type CanaryOptions,
  CONFIG_WRITE_CASE,
  canaryChecks,
  describeRun,
  offlineCanary,
} from "./doctor-canary.ts";
import { spawnProcess } from "./doctor-process.ts";

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

function options(
  hook: CanaryHook,
  td: TestDaemon,
  enforcement: CanaryOptions["enforcement"],
): CanaryOptions {
  return {
    hook,
    home: td.config.daemon.home,
    cwd: f.project,
    env: { PATH: f.bin, HOME: f.home },
    enforcement,
    run: spawnProcess,
  };
}

describe("doctor offline canary: the registered hook, spawned as Claude Code would", () => {
  test("enforce: the config write is killed (exit 2, deny, continue:false), a benign call proceeds", async () => {
    const hook = hookCommand(enforce.config.daemon.socket);
    const result = await offlineCanary(options(hook, enforce, "enforce"));
    expect(result.ok).toBe(true);
    const [write, benign] = result.cases;
    expect(write).toMatchObject({
      name: CONFIG_WRITE_CASE,
      exitCode: 2,
      observed: "exit 2, deny, continue:false",
    });
    expect(benign).toMatchObject({ name: BENIGN_CASE, exitCode: 0, observed: "exit 0, no output" });
    const checks = canaryChecks(result, hook, "enforce");
    expect(checks.map((c) => c.status)).toEqual(["ok", "ok"]);
    expect(checks[0]?.group).toBe("canary");
    const judged = enforce.audit().filter((l) => l.kind === "judge");
    expect(judged.some((l) => String(l.session_id).startsWith("sess_jev-cops-doctor-"))).toBe(true);
  });

  test("observe: the hook cannot block, by design: a warning, not a failure", async () => {
    const hook = hookCommand(observe.config.daemon.socket);
    const result = await offlineCanary(options(hook, observe, "observe"));
    expect(result.ok).toBe(true);
    expect(result.cases[0]?.observed).toBe("exit 0, additionalContext");
    const [write, benign] = canaryChecks(result, hook, "observe");
    expect(write?.status).toBe("warn");
    expect(write?.detail).toContain("enforcement observe: the hook cannot block, by design");
    expect(benign?.status).toBe("ok");
  });

  test("a hook replaced by a no-op (/bin/true-like): the config write gets through, gate silently disabled", async () => {
    const hook = {
      command: executable(f.bin, "cops-hook", "exit 0"),
      args: ["--harness", "claude-code"],
    };
    const result = await offlineCanary(options(hook, enforce, "enforce"));
    expect(result.ok).toBe(false);
    const [write, benign] = canaryChecks(result, hook, "enforce");
    expect(write?.status).toBe("fail");
    expect(write?.detail).toContain("gate silently disabled");
    expect(benign?.status).toBe("ok");
  });

  test("a hook that cannot start or hangs past its timeout fails", async () => {
    const missing = { command: join(f.root, "nope"), args: [] };
    const gone = await offlineCanary(options(missing, enforce, "enforce"));
    expect(gone.cases.map((c) => c.observed)).toEqual(["did not start", "did not start"]);
    const slow = {
      command: executable(f.bin, "slow", "exec /bin/sleep 5"),
      args: [],
      timeoutS: 0.3,
    };
    const hung = await offlineCanary(options(slow, enforce, null));
    expect(hung.ok).toBe(false);
    expect(hung.cases[0]?.observed).toBe("timed out");
    expect(canaryChecks(hung, slow, null)[0]?.detail).toContain("timed out");
  });

  test("what a run looked like, as Claude Code reads it", () => {
    const base = { exitCode: 0, stderr: "", timedOut: false, error: null };
    expect(describeRun({ ...base, stdout: "hello" })).toBe("exit 0, non-JSON output");
    expect(describeRun({ ...base, stdout: '{"a":1}' })).toBe("exit 0, other JSON");
    expect(
      describeRun({
        ...base,
        stdout: '{"hookSpecificOutput":{"permissionDecision":"ask","updatedInput":{}}}',
      }),
    ).toBe("exit 0, ask, updatedInput");
  });
});
