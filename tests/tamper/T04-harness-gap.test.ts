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
 * scope for the hook. Todo: the compiled OpenShell fragment (M2); the Codex and OpenCode
 * installers (M3).
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isUnder } from "../../adapters/claude-code/testing/fs-guard.ts";
import { runInstallCommand } from "../../packages/cli/src/commands/install.ts";
import { captureIo } from "../../packages/cli/src/io.ts";
import { type InstallWorld, installWorld } from "../../packages/cli/src/testing/install-world.ts";
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
