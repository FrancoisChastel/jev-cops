import { describe, expect, test } from "bun:test";
import {
  budgetStatus,
  charge,
  chargeHold,
  createBudget,
  eventCost,
  resetBudget,
} from "./budget.ts";
import { DEFAULT_CONTEXT_CONFIG, resolveContextConfig } from "./config.ts";

const CFG = DEFAULT_CONTEXT_CONFIG.budget;
const MIN = 60_000;
const T0 = 1_000_000;

describe("eventCost", () => {
  test.each([
    [0, 0],
    [0.02, 0],
    [0.03, 1],
    [0.5, 10],
    [0.83, 17],
    [1, 20],
  ])("risk %p costs %p", (risk, cost) => {
    expect(eventCost(risk, CFG)).toBe(cost);
  });

  test("out-of-range and NaN risk fail towards the maximum cost", () => {
    expect(eventCost(Number.NaN, CFG)).toBe(20);
    expect(eventCost(7, CFG)).toBe(20);
    expect(eventCost(-1, CFG)).toBe(0);
  });
});

describe("charge", () => {
  test("adds round(risk * 20) and records the activity time", () => {
    // Arrange
    const b0 = createBudget(CFG);

    // Act
    const { budget, cost } = charge(b0, 0.5, T0, CFG);

    // Assert
    expect(cost).toBe(10);
    expect(budget.spent).toBe(10);
    expect(budget.limit).toBe(100);
    expect(budget.lastActivityAt).toBe(T0);
  });

  test("is immutable: the input budget is unchanged", () => {
    const b0 = createBudget(CFG);
    const { budget } = charge(b0, 1, T0, CFG);
    expect(b0.spent).toBe(0);
    expect(b0.lastActivityAt).toBeNull();
    expect(budget).not.toBe(b0);
  });

  test("decays 10 points per whole minute of inactivity before charging", () => {
    // Arrange
    const b1 = charge(createBudget(CFG), 1, T0, CFG).budget; // 20
    const b2 = charge(b1, 1, T0, CFG).budget; // 40

    // Act
    const almost = charge(b2, 0, T0 + MIN - 1, CFG).budget;
    const oneMin = charge(b2, 0, T0 + MIN, CFG).budget;
    const threeMin = charge(b2, 0.5, T0 + 3 * MIN, CFG).budget;

    // Assert
    expect(almost.spent).toBe(40);
    expect(oneMin.spent).toBe(30);
    expect(threeMin.spent).toBe(20);
  });

  test("decay never goes below zero and ignores a clock that went backwards", () => {
    const b = charge(createBudget(CFG), 0.5, T0, CFG).budget;
    expect(charge(b, 0, T0 + 60 * MIN, CFG).budget.spent).toBe(0);
    expect(charge(b, 0, T0 - 10 * MIN, CFG).budget.spent).toBe(10);
  });

  test("80 % spent raises one step; 100 % holds everything", () => {
    // Arrange
    let b = createBudget(CFG);
    const flags: [number, number, boolean][] = [];

    // Act: 20 points per event, no idle time
    for (let i = 0; i < 5; i++) {
      const r = charge(b, 1, T0, CFG);
      b = r.budget;
      flags.push([b.spent, r.raiseSteps, r.holdAll]);
    }

    // Assert
    expect(flags).toEqual([
      [20, 0, false],
      [40, 0, false],
      [60, 0, false],
      [80, 1, false],
      [100, 1, true],
    ]);
  });

  test("uses the configured limit", () => {
    const cfg = resolveContextConfig({ budget: { limit: 10 } }).budget;
    const r = charge(createBudget(cfg), 0.5, T0, cfg);
    expect(r.holdAll).toBe(true);
  });
});

describe("budgetStatus", () => {
  test("reports the thresholds without charging", () => {
    const b = { ...createBudget(CFG), spent: 85 };
    expect(budgetStatus(b, CFG)).toEqual({ raiseSteps: 1, holdAll: false });
    expect(budgetStatus({ ...b, spent: 10 }, CFG)).toEqual({ raiseSteps: 0, holdAll: false });
  });

  test("a zero limit holds everything", () => {
    expect(budgetStatus({ ...createBudget(CFG), limit: 0 }, CFG).holdAll).toBe(true);
  });
});

describe("chargeHold: repeated holds cost 2x per repeat (T7)", () => {
  test("the surcharge makes each repeat of one key cost double the previous", () => {
    // Arrange
    let b = createBudget(CFG);
    const totals: number[] = [];

    // Act: risk 0.5 → base cost 10; every event is held under the same key
    for (let i = 0; i < 4; i++) {
      const before = b.spent;
      b = charge(b, 0.5, T0, CFG).budget;
      b = chargeHold(b, "exec:rm -rf", 0.5, T0, CFG).budget;
      totals.push(b.spent - before);
    }

    // Assert
    expect(totals).toEqual([10, 20, 40, 80]);
    expect(b.holds).toEqual({ "exec:rm -rf": 4 });
  });

  test("different keys are counted separately", () => {
    const b1 = chargeHold(createBudget(CFG), "a", 0.5, T0, CFG).budget;
    const r = chargeHold(b1, "b", 0.5, T0, CFG);
    expect(r.cost).toBe(0);
    expect(r.budget.holds).toEqual({ a: 1, b: 1 });
  });

  test("the surcharge is capped at the limit", () => {
    const b = { ...createBudget(CFG), holds: { k: 1_000 } };
    expect(chargeHold(b, "k", 1, T0, CFG).cost).toBe(100);
  });
});

describe("resetBudget", () => {
  test("zeroes spent, keeps the limit and the hold counts", () => {
    const b = chargeHold(charge(createBudget(CFG), 1, T0, CFG).budget, "k", 1, T0, CFG).budget;
    const r = resetBudget(b, T0 + 5);
    expect(r).toEqual({ spent: 0, limit: 100, lastActivityAt: T0 + 5, holds: { k: 1 } });
  });
});
