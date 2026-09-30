/**
 * T4 — Harness gap (spec §Threat model).
 *
 * Attack: Subagent in OpenCode; `unified_exec` in Codex; `permissions.allow` in Claude Code
 * Required outcome: Compiled OpenShell fragment blocks the same action; installer warns when the gap is present and unmitigated
 *
 * Status: todo. Milestone: M2 (OpenShell compiler); M1/M3 installers for Claude Code, Codex, OpenCode.
 * Live (M1 step 7): `cops doctor` fails when the hook is missing from the effective Claude
 * Code settings, warns on a bare `Bash` allow rule, and prints every known gap.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { CLAUDE_CODE_GAPS } from "../../adapters/claude-code/src/gaps.ts";
import { offlineCanary } from "../../packages/cli/src/commands/doctor-canary.ts";
import { runDoctor } from "../../packages/cli/src/commands/doctor-run.ts";
import {
  copsToml,
  type DoctorFixture,
  doctorEnv,
  doctorFixture,
  installHook,
  REPO_POLICIES,
} from "../../packages/cli/src/testing/doctor.ts";
import { startTestDaemon, type TestDaemon } from "../../packages/daemon/src/testing/daemon.ts";
import { pending } from "./pending.ts";

const REQUIRED_OUTCOME =
  "Compiled OpenShell fragment blocks the same action; installer warns when the gap is present and unmitigated";

describe("T4 harness gap", () => {
  test.todo(
    REQUIRED_OUTCOME,
    pending("M2 (OpenShell compiler); M1/M3 installers for Claude Code, Codex, OpenCode"),
  );
});

/** Live since M1 step 7: `cops doctor` reports the Claude Code gap (the installer half is `cops install`). */
describe("T4 Claude Code: cops doctor reports the gap when present and unmitigated", () => {
  let td: TestDaemon;
  let f: DoctorFixture;
  beforeAll(async () => {
    td = await startTestDaemon({ policies: {}, policiesDir: REPO_POLICIES });
  });
  afterAll(async () => {
    await td.stop();
  });
  beforeEach(() => {
    f = doctorFixture();
  });
  afterEach(() => f.dispose());

  const doctor = () =>
    runDoctor(
      { harness: "claude-code", live: false, config: copsToml(f, td.config) },
      { env: doctorEnv(f), canary: offlineCanary, notice: () => {} },
    );

  test("the jev-cops hook missing from the effective settings is a failure", async () => {
    const none = (await doctor()).find((c) => c.name === "registered");
    expect(none?.status).toBe("fail");
    expect(none?.detail).toContain("every tool runs unjudged");
    installHook(f, td.config.daemon.socket, { disableAllHooks: true });
    const checks = await doctor();
    const registered = checks.find((c) => c.name === "registered");
    expect(registered?.status).toBe("fail");
    expect(registered?.detail).toContain("disableAllHooks");
    expect(checks.find((c) => c.name === "disableAllHooks")?.status).toBe("fail");
  });

  test("a bare Bash allow rule (the permissions.allow gap) is reported present and unmitigated", async () => {
    installHook(f, td.config.daemon.socket, { permissions: { allow: ["Bash"] } });
    const allow = (await doctor()).find((c) => c.name === "permissions.allow");
    expect(allow?.status).toBe("warn");
    expect(allow?.detail).toContain("present and unmitigated");
  });

  test("every known gap it cannot close is printed as a gap, never silent", async () => {
    const gaps = (await doctor()).filter((c) => c.status === "gap").map((c) => c.detail);
    expect(gaps).toEqual([...CLAUDE_CODE_GAPS]);
  });
});
