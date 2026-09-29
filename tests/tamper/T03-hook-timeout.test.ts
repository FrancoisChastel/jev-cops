/**
 * T3 — Hook timeout (spec §Threat model).
 *
 * Attack: Daemon sleeps 15 seconds on one event
 * Required outcome: Adapter returns `deny` with reason "judge timeout", never allow-by-timeout
 *
 * Status: live (daemon side): a judge that sleeps 15 s gets `504 { error: "judge timeout" }`
 * at the per-request deadline, never a verdict. Live (Pi adapter): the 504 blocks the call
 * with reason "judge timeout". Live (Claude Code hook, M1): the hook owns its deadline
 * (13 s, below the 30 s settings timeout, because Claude Code lets a timed-out hook's call
 * proceed); past it the hook exits 2 with "judge timeout" (shortened here with
 * `JEVDICT_HOOK_DEADLINE_MS`).
 */
import { afterEach, describe, expect, test } from "bun:test";
import { createMockJudge } from "@jevdict/core";
import { register } from "../../adapters/pi/jevdict.ts";
import { FakePi, fakeContext } from "../../adapters/pi/testing/fake-pi.ts";
import {
  startTestDaemon,
  type TestDaemon,
  withFreshId,
} from "../../packages/daemon/src/testing/daemon.ts";
import { policyModule } from "../../packages/daemon/src/testing/policies.ts";
import { buildEvent } from "../fixtures/context/index.ts";
import { claudeCode, claudeWorkspace } from "./claude-code.ts";

const REQUIRED_OUTCOME =
  'Adapter returns `deny` with reason "judge timeout", never allow-by-timeout';
const ASKS = policyModule(
  "asks",
  1,
  "allow",
  'ask: () => [{ kind: "noul", name: "ok", text: "Ok?" }],',
);

let td: TestDaemon | null = null;
afterEach(async () => {
  await td?.stop();
  td = null;
});

describe("T3 hook timeout", () => {
  test("daemon side: a 15 s judge is cut at the deadline with 504 'judge timeout'", async () => {
    td = await startTestDaemon({
      policies: { "asks.ts": ASKS },
      judge: createMockJudge(
        { "asks/ok": { kind: "noul", p: 1, confidence: 1 } },
        { delayMs: 15_000 },
      ),
      deadlineMs: 200,
      judgeTimeoutMs: 1_000,
      policy: { ask: { min: 0 } },
    });
    const started = performance.now();
    const res = await td.call(
      "POST",
      "/v1/judge",
      withFreshId(buildEvent({ tool: "Bash", kind: "exec", input: { command: "ls" } })),
    );
    expect(performance.now() - started).toBeLessThan(1_000);
    expect(res).toEqual({ status: 504, body: { error: "judge timeout" } });
  });

  test(`Pi: ${REQUIRED_OUTCOME}`, async () => {
    td = await startTestDaemon({
      policies: { "asks.ts": ASKS },
      judge: createMockJudge(
        { "asks/ok": { kind: "noul", p: 1, confidence: 1 } },
        { delayMs: 15_000 },
      ),
      deadlineMs: 200,
      judgeTimeoutMs: 1_000,
      policy: { ask: { min: 0 } },
    });
    const pi = new FakePi();
    register(pi, { socket: td.config.daemon.socket });
    const started = performance.now();
    const run = await pi.run(fakeContext({ cwd: td.dir }), "bash", { command: "ls" });
    expect(performance.now() - started).toBeLessThan(1_000);
    expect(run.blocked).toMatchObject({ block: true });
    expect(run.blocked?.reason).toContain("judge timeout");
  });

  test(`Claude Code: ${REQUIRED_OUTCOME}`, async () => {
    td = await startTestDaemon({
      policies: { "asks.ts": ASKS },
      judge: createMockJudge(
        { "asks/ok": { kind: "noul", p: 1, confidence: 1 } },
        { delayMs: 15_000 },
      ),
      deadlineMs: 20_000,
      judgeTimeoutMs: 20_000,
      policy: { ask: { min: 0 } },
    });
    const ws = claudeWorkspace();
    try {
      const deadline = { JEVDICT_HOOK_DEADLINE_MS: "300" };
      const c = claudeCode(td.config.daemon.socket, ws, {}, deadline);
      const started = performance.now();
      const call = await c.tool("Bash", { command: "ls" });
      expect(performance.now() - started).toBeLessThan(3_000);
      expect(call.decision.outcome).toBe("deny");
      expect(call.result).toBe("jevdict: judge timeout; blocking (fail closed)");
      expect(call.ran).toBeNull();
    } finally {
      ws.dispose();
    }
  });
});
