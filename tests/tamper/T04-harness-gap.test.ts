/**
 * T4 — Harness gap (spec §Threat model).
 *
 * Attack: Subagent in OpenCode; `unified_exec` in Codex; `permissions.allow` in Claude Code
 * Required outcome: Compiled OpenShell fragment blocks the same action; installer warns when the gap is present and unmitigated
 *
 * Status: the installer half is live on Claude Code (M1 step 6): `cops install claude-code`
 * refuses a bare `Bash`/`PowerShell` entry in `permissions.allow` at any scope (spec: "The
 * installer must refuse to run when `Bash` is on the allow list") and `disableAllHooks`,
 * installs past them only with `--force` (recording the gap), and always prints that without
 * OpenShell every deny is best-effort and that `--dangerously-skip-permissions` is out of
 * scope for the hook. The doctor half is live (M1 step 7): `cops doctor` fails when the hook
 * is missing from the effective Claude Code settings, warns on a bare `Bash` allow rule, and
 * prints every known gap. Todo: the compiled OpenShell fragment (M2); the Codex and OpenCode
 * installers (M3).
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CLAUDE_CODE_GAPS } from "../../adapters/claude-code/src/gaps.ts";
import { isUnder } from "../../adapters/claude-code/testing/fs-guard.ts";
import { runDoctor } from "../../packages/cli/src/commands/doctor-run.ts";
import { runInstallCommand } from "../../packages/cli/src/commands/install.ts";
import { captureIo } from "../../packages/cli/src/io.ts";
import {
  copsToml,
  type DoctorFixture,
  doctorEnv,
  doctorFixture,
  installHook,
  REPO_POLICIES,
} from "../../packages/cli/src/testing/doctor.ts";
import { type InstallWorld, installWorld } from "../../packages/cli/src/testing/install-world.ts";
import { startTestDaemon, type TestDaemon } from "../../packages/daemon/src/testing/daemon.ts";
import { pending } from "./pending.ts";

const REQUIRED_OUTCOME =
  "Compiled OpenShell fragment blocks the same action; installer warns when the gap is present and unmitigated";

let w: InstallWorld;
beforeEach(() => {
  w = installWorld();
});
afterEach(() => {
  for (const p of w.fs.written) expect(isUnder(p, [w.root])).toBe(true);
  w.dispose();
});

function settings(path: string, value: Record<string, unknown>): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, JSON.stringify(value));
}

/** `cops install claude-code` in the temp world with the real hook binary. */
async function install(...extra: string[]) {
  const io = captureIo();
  const socket = join(w.root, "copsd.sock");
  const argv = ["claude-code", "--home", w.home, "--hook-binary", w.hook, "--socket", socket];
  const code = await runInstallCommand([...argv, ...extra], io, w.ctx());
  return { code, out: io.stdout.join("\n") };
}

const userSettings = () => join(w.home, ".claude", "settings.json");

describe("T4 harness gap", () => {
  describe("Claude Code: installer warns when the gap is present and unmitigated", () => {
    test.each([
      ["user", () => userSettings(), "Bash"],
      ["project", () => join(w.project, ".claude", "settings.json"), "Bash(*)"],
      ["local", () => join(w.project, ".claude", "settings.local.json"), "PowerShell"],
    ])(
      "a bare shell allow rule in %s settings: refused, nothing written",
      async (_s, path, rule) => {
        settings(path(), { permissions: { allow: [rule] } });
        const r = await install();
        expect(r.code).toBe(1);
        expect(r.out).toContain("refused to install");
        expect(r.out).toContain(`"${rule}"`);
        expect(existsSync(join(w.home, ".config", "jev-cops", "cops.toml"))).toBe(false);
        expect(w.fs.written).toEqual([]);
      },
    );

    test("disableAllHooks: refused", async () => {
      settings(join(w.project, ".claude", "settings.local.json"), { disableAllHooks: true });
      const r = await install();
      expect(r.code).toBe(1);
      expect(r.out).toContain("disableAllHooks");
    });

    test("--force goes past the gap and prints it as FORCED", async () => {
      settings(userSettings(), { permissions: { allow: ["Bash"] } });
      const r = await install("--force", "--dry-run");
      expect(r.code).toBe(0);
      expect(r.out).toContain("warning: FORCED:");
      expect(r.out).toContain('"Bash"');
    });

    test("no OpenShell: the installer always warns that every deny is best-effort", async () => {
      const r = await install("--dry-run");
      expect(r.code).toBe(0);
      expect(r.out).toContain("warning: Without OpenShell, every deny is best-effort");
      expect(r.out).toContain("--dangerously-skip-permissions");
      expect(r.out).toContain("known gaps");
    });
  });

  test.todo(
    `OpenShell: ${REQUIRED_OUTCOME}`,
    pending("M2 (OpenShell compiler); M3 installers for Codex and OpenCode"),
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
      { env: doctorEnv(f), notice: () => {} },
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
