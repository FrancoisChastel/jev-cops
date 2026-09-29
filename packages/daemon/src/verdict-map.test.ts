import { describe, expect, test } from "bun:test";
import {
  createCaseFile,
  createDisabledJudge,
  createPolicyEngine,
  type Decision,
  type PolicyDefinition,
  type PreEvent,
  parseEvent,
  parseVerdict,
  resolvePolicyConfig,
  type Verdict,
} from "@jevdict/core";
import { loadEventFixture } from "../../../tests/fixtures/events/index.ts";
import {
  HARNESS_RISK_STEP,
  HEADLESS_HOLD_DENIED,
  harnessVerdict,
  latchedVerdict,
  OBSERVE_ONLY,
  PERMISSION_MODE_HOLD_DENIED,
  SESSION_KILLED,
  SESSION_KILLED_REASON,
} from "./verdict-map.ts";

const EVENT = (() => {
  const parsed = parseEvent(loadEventFixture("pre-bash"));
  if (!parsed.ok || parsed.value.phase !== "pre") throw new Error("fixture");
  return parsed.value as PreEvent;
})();

async function decide(verdict: Verdict): Promise<Decision> {
  const policy: PolicyDefinition = {
    name: "fixed",
    version: 1,
    owner: "tests",
    when: () => true,
    decide: () => verdict,
    reason: `Fixed ${verdict}.`,
    detail: () => "human-only detail",
    rewrite: () => ({ command: "rm -rf ./node_modules" }),
    contextNote: () => "a note",
  };
  const engine = createPolicyEngine({
    policies: [policy],
    judge: createDisabledJudge(),
    policyConfig: resolvePolicyConfig({ when: { budgetMs: 1_000 } }),
  });
  const cf = createCaseFile(EVENT.session.id);
  return (await engine.judge(EVENT, cf, { home: "/home/dev" })).decision;
}

describe("harnessVerdict", () => {
  test("detail never reaches the harness", async () => {
    const d = await decide("hold");
    expect(d.detail).toContain("human-only detail");
    const { response } = harnessVerdict(d, EVENT.id, "enforce", null);
    expect(response).not.toHaveProperty("detail");
    expect(JSON.stringify(response)).not.toContain("human-only detail");
  });

  test("scores never reach the harness: no features, no judge answers, risk to one decimal (T6)", async () => {
    const d = await decide("hold");
    const asked: Decision = {
      ...d,
      risk: 0.6789,
      jev: [{ question: "fixed/safe", type: "noul", p: 0.83, confidence: 0.7 }],
    };
    expect(Object.keys(asked.features)).toHaveLength(5);
    const { response } = harnessVerdict(asked, EVENT.id, "enforce", null);
    expect(response).toMatchObject({ features: {}, jev: [], risk: 0.7 });
    expect(response.policies).toEqual([...d.policies]);
    expect(response.budget).toEqual(d.budget);
    expect(parseVerdict(response).ok).toBe(true);
    expect(HARNESS_RISK_STEP).toBe(0.1);
  });

  test.each([
    [0, 0],
    [0.04, 0],
    [0.05, 0.1],
    [0.34999, 0.3],
    [0.95, 1],
    [1, 1],
  ])("risk %p is returned as %p", async (risk, shown) => {
    const d = { ...(await decide("allow")), risk };
    expect(harnessVerdict(d, EVENT.id, "enforce", null).response.risk).toBe(shown);
  });

  test("enforce + interactive returns the verdict as is", async () => {
    const d = await decide("rewrite");
    const { response, mapping } = harnessVerdict(d, EVENT.id, "enforce", null);
    expect(response.verdict).toBe("rewrite");
    expect(response.updated_input).toEqual({ command: "rm -rf ./node_modules" });
    expect(mapping).toEqual([]);
  });

  test("D-008: headless hold becomes deny with the same reason", async () => {
    const d = await decide("hold");
    const { response, mapping } = harnessVerdict(d, EVENT.id, "enforce", "headless");
    expect(response.verdict).toBe("deny");
    expect(response.reason).toBe(d.reason);
    expect(mapping).toEqual([HEADLESS_HOLD_DENIED]);
  });

  test("headless leaves every other verdict alone", async () => {
    const d = await decide("deny");
    expect(harnessVerdict(d, EVENT.id, "enforce", "headless").response.verdict).toBe("deny");
  });

  test("observe returns allow and says what would have happened for hold and above", async () => {
    const d = await decide("deny");
    const { response, mapping } = harnessVerdict(d, EVENT.id, "observe", null);
    expect(response.verdict).toBe("allow");
    expect(response.context_note).toBe(`jevdict would have: deny — ${d.reason}`);
    expect(mapping).toEqual([OBSERVE_ONLY]);
  });

  test("observe drops a rewrite and adds no note below hold", async () => {
    const d = await decide("rewrite");
    const { response } = harnessVerdict(d, EVENT.id, "observe", null);
    expect(response).toMatchObject({ verdict: "allow", updated_input: null, context_note: null });
  });

  test("observe after the headless mapping reports the deny", async () => {
    const d = await decide("hold");
    const { response, mapping } = harnessVerdict(d, EVENT.id, "observe", "headless");
    expect(response.verdict).toBe("allow");
    expect(response.context_note).toStartWith("jevdict would have: deny");
    expect(mapping).toEqual([HEADLESS_HOLD_DENIED, OBSERVE_ONLY]);
  });

  test("a permission mode that never prompts turns hold into deny (plan §5 row 10)", async () => {
    const d = await decide("hold");
    const { response, mapping } = harnessVerdict(d, EVENT.id, "enforce", "permission-mode");
    expect(response).toMatchObject({ verdict: "deny", reason: d.reason, updated_input: null });
    expect(mapping).toEqual([PERMISSION_MODE_HOLD_DENIED]);
    const denied = harnessVerdict(await decide("annotate"), EVENT.id, "enforce", "permission-mode");
    expect(denied.response.verdict).toBe("annotate");
  });
});

describe("latchedVerdict", () => {
  test("kill with the session-terminated reason, no policies, the budget unchanged", () => {
    const budget = { spent: 42, limit: 100, lastActivityAt: 1, holds: { k: 2 } };
    const { response, mapping } = latchedVerdict(EVENT.id, budget);
    expect(parseVerdict(response).ok).toBe(true);
    expect(response).toMatchObject({
      event_id: EVENT.id,
      verdict: "kill",
      risk: 1,
      reason: SESSION_KILLED_REASON,
      policies: [],
      budget: { spent: 42, limit: 100 },
    });
    expect(response.budget).toEqual({ spent: 42, limit: 100 });
    expect(mapping).toEqual([SESSION_KILLED]);
  });
});
