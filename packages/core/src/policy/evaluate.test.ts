import { describe, expect, test } from "bun:test";
import { resolvePolicyConfig } from "./config.ts";
import { createWhenTracker, evaluatePolicies, policyKey } from "./evaluate.ts";
import type { PolicyContext, PolicyDefinition, PolicyEvent } from "./types.ts";

const E = {} as PolicyEvent;
const CTX = {} as PolicyContext;
const CFG = resolvePolicyConfig();

function policy(name: string, when: PolicyDefinition["when"]): PolicyDefinition {
  return { name, version: 1, owner: "t", when, decide: () => "hold", reason: "r" };
}

function busyWait(ms: number): void {
  const until = performance.now() + ms;
  while (performance.now() < until) {
    // spin: a `when` that is too slow
  }
}

function run(policies: PolicyDefinition[], tracker = createWhenTracker(10), sessionId = "s1") {
  return evaluatePolicies(policies, E, CTX, { tracker, sessionId, config: CFG });
}

describe("evaluatePolicies", () => {
  test("records matched and not matched with timings", () => {
    // Act
    const [yes, no] = run([policy("yes", () => true), policy("no", () => false)]);
    // Assert
    expect(yes).toMatchObject({ key: "yes@1", matched: true, whenOverBudget: false, error: null });
    expect(no).toMatchObject({ key: "no@1", matched: false, whenOverBudget: false });
    expect(yes?.whenMs).toBeGreaterThanOrEqual(0);
  });

  test("a when over the 2 ms budget counts as matched and is traced", () => {
    const [slow] = run([
      policy("slow", () => {
        busyWait(3);
        return false;
      }),
    ]);
    expect(slow).toMatchObject({ matched: true, whenOverBudget: true, degraded: false });
    expect(slow?.whenMs).toBeGreaterThanOrEqual(3);
  });

  test("over budget three times in a session marks the policy degraded", () => {
    const tracker = createWhenTracker(10);
    const slow = policy("slow", () => {
      busyWait(3);
      return false;
    });
    const results = [1, 2, 3, 4].map(() => run([slow], tracker)[0]?.degraded);
    expect(results).toEqual([false, false, true, true]);
    expect(run([slow], tracker, "other-session")[0]?.degraded).toBe(false);
  });

  test("a when that throws or returns a non-boolean counts as matched, with the error", () => {
    const [threw, promised] = run([
      policy("threw", () => {
        throw new Error("bad predicate");
      }),
      policy("promised", (() => Promise.resolve(false)) as unknown as PolicyDefinition["when"]),
    ]);
    expect(threw).toMatchObject({ matched: true, error: "when threw: bad predicate" });
    expect(promised).toMatchObject({ matched: true, error: "when returned object, not a boolean" });
  });

  test("the tracker forgets the least recently used session past its bound", () => {
    const tracker = createWhenTracker(2);
    tracker.strike("a", "p@1");
    tracker.strike("b", "p@1");
    tracker.strike("c", "p@1");
    expect(tracker.strikes("a", "p@1")).toBe(0);
    expect(tracker.strikes("c", "p@1")).toBe(1);
  });

  test("policyKey is name@version", () => {
    expect(policyKey(policy("x", () => true))).toBe("x@1");
  });
});
