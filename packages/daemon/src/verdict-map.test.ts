import { describe, expect, test } from "bun:test";
import {
  createCaseFile,
  createDisabledJudge,
  createPolicyEngine,
  type Decision,
  type PolicyDefinition,
  type PreEvent,
  parseEvent,
  resolvePolicyConfig,
  type Verdict,
} from "@jevdict/core";
import { loadEventFixture } from "../../../tests/fixtures/events/index.ts";
import { HEADLESS_HOLD_DENIED, harnessVerdict, OBSERVE_ONLY } from "./verdict-map.ts";

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
    const { response } = harnessVerdict(d, EVENT.id, "enforce", "interactive");
    expect(response).not.toHaveProperty("detail");
    expect(JSON.stringify(response)).not.toContain("human-only detail");
  });

  test("enforce + interactive returns the verdict as is", async () => {
    const d = await decide("rewrite");
    const { response, mapping } = harnessVerdict(d, EVENT.id, "enforce", "interactive");
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
    const { response, mapping } = harnessVerdict(d, EVENT.id, "observe", "interactive");
    expect(response.verdict).toBe("allow");
    expect(response.context_note).toBe(`jevdict would have: deny — ${d.reason}`);
    expect(mapping).toEqual([OBSERVE_ONLY]);
  });

  test("observe drops a rewrite and adds no note below hold", async () => {
    const d = await decide("rewrite");
    const { response } = harnessVerdict(d, EVENT.id, "observe", "interactive");
    expect(response).toMatchObject({ verdict: "allow", updated_input: null, context_note: null });
  });

  test("observe after the headless mapping reports the deny", async () => {
    const d = await decide("hold");
    const { response, mapping } = harnessVerdict(d, EVENT.id, "observe", "headless");
    expect(response.verdict).toBe("allow");
    expect(response.context_note).toStartWith("jevdict would have: deny");
    expect(mapping).toEqual([HEADLESS_HOLD_DENIED, OBSERVE_ONLY]);
  });
});
