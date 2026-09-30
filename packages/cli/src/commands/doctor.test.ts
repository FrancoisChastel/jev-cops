/**
 * `cops doctor` end to end on a temp home, a temp project and a PATH holding only
 * stand-ins, against a real copsd with the repo's policies. Nothing reads the real home
 * or starts the real `claude`.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { CLAUDE_CODE_GAPS } from "@jev-cops/adapter-claude-code";
import { PI_GAPS } from "@jev-cops/adapter-pi/install";
import { startTestDaemon, type TestDaemon } from "../../../daemon/src/testing/daemon.ts";
import { captureIo } from "../io.ts";
import {
  copsToml,
  type DoctorFixture,
  doctorEnv,
  doctorFixture,
  installHook,
  REPO_POLICIES,
  standInClaude,
  trust,
  writeJson,
} from "../testing/doctor.ts";
import { type DoctorProcess, PROCESS_DOCTOR, parseDoctorArgs, runDoctorCommand } from "./doctor.ts";
import { offlineCanary } from "./doctor-canary.ts";
import { processDoctorEnv } from "./doctor-process.ts";
import type { DoctorEnv } from "./doctor-types.ts";

let td: TestDaemon;
let f: DoctorFixture;
let toml = "";

beforeAll(async () => {
  td = await startTestDaemon({ policies: {}, policiesDir: REPO_POLICIES });
});
afterAll(async () => {
  await td.stop();
});
beforeEach(() => {
  f = doctorFixture();
  toml = copsToml(f, td.config);
});
afterEach(() => f.dispose());

function proc(e: DoctorEnv = doctorEnv(f), tty = false, notices: string[] = []): DoctorProcess {
  return { deps: () => ({ env: e, canary: offlineCanary, notice: (l) => notices.push(l) }), tty };
}

/** A healthy Claude Code setup: hook installed, folder trusted, version recorded, claude 2.1.285. */
function healthy(): void {
  installHook(f, td.config.daemon.socket);
  trust(f, f.project);
  writeJson(join(f.home, ".jev-cops", "claude-code.json"), { claude_version: "2.1.285" });
  standInClaude(f);
}

interface JsonReport {
  schema: string;
  exit_code: number;
  harness: string;
  counts: Record<string, number>;
  checks: { group: string; name: string; status: string; detail: string }[];
}

async function doctorJson(
  args: string[],
  p: DoctorProcess = proc(),
): Promise<{ code: number; report: JsonReport }> {
  const io = captureIo();
  const code = await runDoctorCommand([...args, "--json", "--config", toml], io, p);
  return { code, report: JSON.parse(io.stdout.join("\n")) as JsonReport };
}

describe("cops doctor", () => {
  test("a healthy Claude Code setup: no failure, exit 0, the canary passes, every gap printed", async () => {
    healthy();
    const { code, report } = await doctorJson(["--harness", "claude-code"]);
    const failed = report.checks.filter((c) => c.status === "fail");
    expect(failed).toEqual([]);
    expect(code).toBe(0);
    expect(report).toMatchObject({
      schema: "jev-cops.doctor/1",
      exit_code: 0,
      harness: "claude-code",
    });
    const canary = report.checks.filter((c) => c.group === "canary");
    expect(canary.map((c) => c.status)).toEqual(["ok", "ok"]);
    const gaps = report.checks.filter((c) => c.status === "gap").map((c) => c.detail);
    expect(gaps).toEqual([...CLAUDE_CODE_GAPS]);
    expect(report.counts.gap).toBe(CLAUDE_CODE_GAPS.length);
    expect(report.checks.find((c) => c.name === "chain")?.status).toBe("ok");
  });

  test("the hook missing from the effective settings: fail, exit 1 (T4, doctor half)", async () => {
    standInClaude(f);
    const { code, report } = await doctorJson(["--harness", "claude-code"]);
    expect(code).toBe(1);
    expect(report.checks.find((c) => c.name === "registered")?.status).toBe("fail");
    expect(report.checks.find((c) => c.group === "canary")?.detail).toContain("not run");
  });

  test("copsd down: fail with a hint, exit 1, and the gaps are still printed", async () => {
    healthy();
    const io = captureIo();
    const down = [
      "--socket",
      join(f.root, "none.sock"),
      "--admin-socket",
      join(f.root, "none-a.sock"),
    ];
    const code = await runDoctorCommand([...down, "--config", toml], io, proc());
    expect(code).toBe(1);
    const text = io.stdout.join("\n");
    expect(text).toContain("[FAIL] agent socket");
    expect(text).toContain("start copsd");
    for (const gap of [...CLAUDE_CODE_GAPS, ...PI_GAPS]) expect(text).toContain(gap);
  });

  test("--harness all with neither harness here: skipped with warnings, both gap lists printed", async () => {
    const { code, report } = await doctorJson([]);
    expect(code).toBe(0);
    expect(report.checks.find((c) => c.group === "claude-code")?.detail).toContain("not detected");
    expect(report.checks.find((c) => c.group === "pi")?.detail).toContain("not detected");
    expect(report.checks.filter((c) => c.status === "gap")).toHaveLength(
      CLAUDE_CODE_GAPS.length + PI_GAPS.length,
    );
  });

  test("--harness pi: a missing extension fails; the Claude Code checks are not run", async () => {
    const { code, report } = await doctorJson(["--harness", "pi"]);
    expect(code).toBe(1);
    expect(report.checks.some((c) => c.group.startsWith("claude-code"))).toBe(false);
    expect(report.checks.filter((c) => c.group === "pi gaps")).toHaveLength(PI_GAPS.length);
  });

  test("human output: grouped, ✓ ! ✗ • on a terminal, bracketed words otherwise", async () => {
    healthy();
    const tty = captureIo();
    expect(
      await runDoctorCommand(
        ["--harness", "claude-code", "--config", toml],
        tty,
        proc(doctorEnv(f), true),
      ),
    ).toBe(0);
    const text = tty.stdout.join("\n");
    expect(text).toMatch(/^cops doctor \(jev-cops /);
    expect(text).toContain("\ncopsd\n  ✓ agent socket");
    expect(text).toContain("\nclaude-code gaps\n  • ");
    expect(text).toContain("  ! judge");
    expect(text).toMatch(/\d+ ok · \d+ warn · 0 fail · \d+ gap → exit 0$/);
  });

  test("a bad config file fails the config check", async () => {
    const io = captureIo();
    const bad = join(f.root, "missing.toml");
    expect(await runDoctorCommand(["--harness", "pi", "--config", bad], io, proc())).toBe(1);
    expect(io.stdout.join("\n")).toContain("config file not found");
  });

  test("usage errors exit 2", async () => {
    for (const argv of [["--harness", "codex"], ["extra"], ["--frob"]]) {
      const io = captureIo();
      expect(await runDoctorCommand(argv, io, proc())).toBe(2);
      expect(io.stderr[0]).toMatch(/^cops doctor: /);
    }
  });

  test("arguments: defaults, every flag", () => {
    expect(parseDoctorArgs([])).toEqual({
      ok: true,
      options: { harness: "all", live: false },
      json: false,
      home: null,
    });
    const all = [
      "--harness",
      "pi",
      "--live",
      "--json",
      "--socket",
      "/s",
      "--admin-socket",
      "/a",
      "--config",
      "c.toml",
      "--home",
      "/h",
    ];
    expect(parseDoctorArgs(all)).toEqual({
      ok: true,
      options: { harness: "pi", live: true, socket: "/s", adminSocket: "/a", config: "c.toml" },
      json: true,
      home: "/h",
    });
  });

  test("the real process wiring reads nothing until run: home override, notices to stderr", () => {
    const io = captureIo();
    const deps = PROCESS_DOCTOR.deps(f.home, io);
    expect(deps.env.home).toBe(f.home);
    deps.notice("hello");
    expect(io.stderr).toEqual(["hello"]);
    expect(typeof PROCESS_DOCTOR.tty).toBe("boolean");
    const own = processDoctorEnv();
    expect(own.cwd).toBe(process.cwd());
    expect(own.which("jev-cops-no-such-command")).toBeNull();
  });
});
