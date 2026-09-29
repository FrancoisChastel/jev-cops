/**
 * T3 — Hook timeout (spec §Threat model).
 *
 * Attack: Daemon sleeps 15 seconds on one event
 * Required outcome: Adapter returns `deny` with reason "judge timeout", never allow-by-timeout
 *
 * Status: live (daemon side): a judge that sleeps 15 s gets `504 { error: "judge timeout" }`
 * at the per-request deadline, never a verdict. Mapping 504 to `deny` is the adapter's
 * (M0 step 10).
 */
import { afterEach, describe, expect, test } from "bun:test";
import { createMockJudge } from "@jevdict/core";
import {
  startTestDaemon,
  type TestDaemon,
  withFreshId,
} from "../../packages/daemon/src/testing/daemon.ts";
import { policyModule } from "../../packages/daemon/src/testing/policies.ts";
import { buildEvent } from "../fixtures/context/index.ts";
import { pending } from "./pending.ts";

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

  test.todo(REQUIRED_OUTCOME, pending("M0 step 10 (Pi adapter)"));
});
