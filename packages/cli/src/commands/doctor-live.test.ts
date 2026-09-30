/**
 * The `--live` canary runs only against a stand-in `claude` (testing/fake-claude.ts) on a
 * PATH that holds nothing else: the real `claude` is never started from a test.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { startTestDaemon, type TestDaemon } from "../../../daemon/src/testing/daemon.ts";
import {
  type DoctorFixture,
  doctorEnv,
  doctorFixture,
  installHook,
  REPO_POLICIES,
  standInClaude,
} from "../testing/doctor.ts";
import { LIVE_ENV, LIVE_NOTICE, liveCanaryChecks } from "./doctor-live.ts";
import type { DoctorEnv, ProcessRunner } from "./doctor-types.ts";

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

const never: ProcessRunner = () => {
  throw new Error("no process may start");
};

function live(e: DoctorEnv, notices: string[] = []) {
  return liveCanaryChecks({ e, auditPath: td.config.audit.path, notice: (l) => notices.push(l) });
}

describe("doctor --live: a real claude run reaches copsd (gated, never in CI)", () => {
  test(`without ${LIVE_ENV}=1 it is skipped, and nothing is started`, async () => {
    standInClaude(f);
    const checks = await live({ ...doctorEnv(f), run: never });
    expect(checks).toHaveLength(1);
    expect(checks[0]).toMatchObject({ group: "live canary", status: "warn" });
    expect(checks[0]?.detail).toContain(`${LIVE_ENV}=1`);
    expect(checks[0]?.detail).toContain("billed to your Claude account");
  });

  test("with the flag but no claude on PATH: skipped", async () => {
    const checks = await live({ ...doctorEnv(f, { [LIVE_ENV]: "1" }), run: never });
    expect(checks[0]?.status).toBe("warn");
    expect(checks[0]?.detail).toContain("not on PATH");
  });

  test("the stand-in claude runs the registered hook: a judge line with the nonce, both allow-list cases", async () => {
    standInClaude(f);
    installHook(f, td.config.daemon.socket);
    const log = join(f.root, "claude-argv.jsonl");
    const notices: string[] = [];
    const checks = await live(doctorEnv(f, { [LIVE_ENV]: "1", FAKE_CLAUDE_LOG: log }), notices);
    expect(notices).toEqual([LIVE_NOTICE]);
    expect(LIVE_NOTICE).toContain("billed to your Claude account");
    expect(checks.map((c) => c.status)).toEqual(["ok", "ok"]);
    expect(checks[1]?.name).toContain("bare Bash");
    const runs = readFileSync(log, "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as string[]);
    expect(runs).toHaveLength(2);
    for (const [i, allowed] of ["Bash(printf *)", "Bash"].entries()) {
      const argv = runs[i] ?? [];
      expect(argv[0]).toBe("-p");
      expect(argv[1]).toMatch(
        /^Run exactly this shell command and nothing else: printf jev-cops-canary-[0-9a-f]+$/,
      );
      expect(argv.slice(2)).toEqual([
        "--permission-mode",
        "dontAsk",
        "--max-turns",
        "2",
        "--output-format",
        "json",
        "--allowedTools",
        allowed,
      ]);
    }
  });

  test("no hook registered: claude runs but copsd never sees the call: fail", async () => {
    standInClaude(f);
    const checks = await live(doctorEnv(f, { [LIVE_ENV]: "1" }));
    expect(checks.map((c) => c.status)).toEqual(["fail", "fail"]);
    expect(checks[0]?.detail).toContain("did not reach copsd");
  });

  test("claude output that is not the JSON result: fail", async () => {
    standInClaude(f);
    const checks = await live(doctorEnv(f, { [LIVE_ENV]: "1", FAKE_CLAUDE_GARBLE: "1" }));
    expect(checks[0]?.status).toBe("fail");
    expect(checks[0]?.detail).toContain("no session_id");
  });
});
