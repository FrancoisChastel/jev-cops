import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  type DoctorFixture,
  doctorEnv,
  doctorFixture,
  executable,
  trust,
  writeJson,
} from "../testing/doctor.ts";
import {
  claudeVersionChecks,
  compareVersions,
  DOCS_VERIFIED_VERSION,
  hookLogCheck,
  LOG_WARN_BYTES,
  parseVersion,
  recordedVersionCheck,
  trustCheck,
} from "./doctor-claude.ts";

let f: DoctorFixture;
beforeEach(() => {
  f = doctorFixture();
});
afterEach(() => f.dispose());

const claudeSays = (out: string, code = 0) =>
  executable(f.bin, "claude", `[ "$1" = --version ] && echo '${out}'; exit ${code}`);

describe("doctor: claude on PATH and its version", () => {
  test("versions parse and compare numerically", () => {
    expect(parseVersion("2.1.285 (Claude Code)")).toEqual([2, 1, 285]);
    expect(parseVersion("claude")).toBeNull();
    expect(compareVersions([2, 1, 99], [2, 1, 101])).toBeLessThan(0);
    expect(compareVersions([2, 10, 0], [2, 9, 999])).toBeGreaterThan(0);
    expect(compareVersions([2, 1, 285], [2, 1, 285])).toBe(0);
  });

  test("the docs-verified version is ok", async () => {
    claudeSays(`${DOCS_VERIFIED_VERSION} (Claude Code)`);
    const r = await claudeVersionChecks(doctorEnv(f));
    expect(r.version).toBe(DOCS_VERIFIED_VERSION);
    expect(r.checks.map((c) => [c.name, c.status])).toEqual([
      ["claude on PATH", "ok"],
      ["claude version", "ok"],
    ]);
  });

  test("drift from the verified version warns; below 2.1.101 fails", async () => {
    claudeSays("2.1.300 (Claude Code)");
    const newer = (await claudeVersionChecks(doctorEnv(f))).checks[1];
    expect(newer?.status).toBe("warn");
    expect(newer?.detail).toContain(DOCS_VERIFIED_VERSION);
    claudeSays("2.1.100 (Claude Code)");
    const old = (await claudeVersionChecks(doctorEnv(f))).checks[1];
    expect(old?.status).toBe("fail");
    expect(old?.detail).toContain("2.1.101");
  });

  test("no claude on PATH, or no version out of it: warnings", async () => {
    const none = await claudeVersionChecks(doctorEnv(f));
    expect(none.checks).toHaveLength(1);
    expect(none.checks[0]?.status).toBe("warn");
    expect(none.version).toBeNull();
    claudeSays("oops", 3);
    const bad = (await claudeVersionChecks(doctorEnv(f))).checks[1];
    expect(bad?.status).toBe("warn");
    expect(bad?.detail).toContain("exit 3");
  });
});

describe("doctor: the recorded version (~/.jev-cops/claude-code.json)", () => {
  const state = () => join(f.home, ".jev-cops", "claude-code.json");

  test("missing: warn, pointing at install (doctor never writes it)", () => {
    const c = recordedVersionCheck(f.home, "2.1.285");
    expect(c.status).toBe("warn");
    expect(c.detail).toContain("cops install claude-code");
  });

  test("same, different, invalid", () => {
    writeJson(state(), { claude_version: "2.1.285" });
    expect(recordedVersionCheck(f.home, "2.1.285").status).toBe("ok");
    expect(recordedVersionCheck(f.home, null).status).toBe("ok");
    const drift = recordedVersionCheck(f.home, "2.1.290");
    expect(drift.status).toBe("warn");
    expect(drift.detail).toContain("2.1.290");
    writeFileSync(state(), "{");
    expect(recordedVersionCheck(f.home, null).detail).toContain("unreadable or invalid");
  });
});

describe("doctor: the hook's local log", () => {
  const log = () => join(f.home, ".jev-cops", "claude-code-hook.log");

  test("absent, small, over the threshold", () => {
    expect(hookLogCheck(f.home).status).toBe("ok");
    mkdirSync(join(f.home, ".jev-cops"));
    writeFileSync(log(), "a\nb\n");
    expect(hookLogCheck(f.home)).toMatchObject({ status: "ok" });
    expect(hookLogCheck(f.home).detail).toContain("2 lines");
    writeFileSync(log(), "x".repeat(LOG_WARN_BYTES + 1));
    expect(hookLogCheck(f.home).status).toBe("warn");
  });
});

describe("doctor: workspace trust of the cwd (~/.claude.json)", () => {
  test("no global config: warn that interactive sessions run no hook", () => {
    const c = trustCheck(doctorEnv(f), f.project);
    expect(c.status).toBe("warn");
    expect(c.detail).toContain("interactive sessions run no hook");
  });

  test("the folder, or a trusted parent outside a repository: ok", () => {
    trust(f, f.project);
    expect(trustCheck(doctorEnv(f), f.project).status).toBe("ok");
    trust(f, f.root);
    const sub = join(f.project, "sub");
    mkdirSync(sub);
    expect(trustCheck(doctorEnv(f), sub).status).toBe("ok");
  });

  test("a repository needs its own root trusted, not a parent's", () => {
    mkdirSync(join(f.project, ".git"));
    trust(f, f.root);
    expect(trustCheck(doctorEnv(f), f.project).status).toBe("warn");
    trust(f, f.project);
    expect(trustCheck(doctorEnv(f), f.project).status).toBe("ok");
    trust(f, f.project, false);
    expect(trustCheck(doctorEnv(f), f.project).status).toBe("warn");
  });

  test("CLAUDE_CONFIG_DIR's .claude.json is read first; invalid JSON warns", () => {
    const configDir = join(f.root, "cfg");
    writeJson(join(configDir, ".claude.json"), {
      projects: { [f.project]: { hasTrustDialogAccepted: true } },
    });
    const c = trustCheck(doctorEnv(f, { CLAUDE_CONFIG_DIR: configDir }), f.project);
    expect(c.status).toBe("ok");
    expect(c.detail).toContain(configDir);
    writeFileSync(join(f.home, ".claude.json"), "not json");
    expect(trustCheck(doctorEnv(f), f.project).detail).toContain("cannot read");
  });

  test("the home directory: trust is per session", () => {
    trust(f, f.home);
    expect(trustCheck(doctorEnv(f), f.home).detail).toContain("one session");
  });
});
