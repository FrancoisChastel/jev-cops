import { describe, expect, test } from "bun:test";
import type { Features } from "../context/features.ts";
import { DEFAULT_POLICY_CONFIG, resolvePolicyConfig } from "./config.ts";
import { bandVerdict, floorRisk } from "./floor.ts";

const ZERO: Features = { taint: 0, scope: 1, sequence: 0, environment: 0, reversibility: 0 };
const ONE: Features = { taint: 1, scope: 0, sequence: 1, environment: 1, reversibility: 1 };

describe("floorRisk", () => {
  test("0.35·taint + 0.25·(1−scope) + 0.20·sequence + 0.10·environment + 0.10·reversibility", () => {
    const f: Features = {
      taint: 0.5,
      scope: 0.4,
      sequence: 0.9,
      environment: 0.3,
      reversibility: 1,
    };
    const expected = 0.35 * 0.5 + 0.25 * 0.6 + 0.2 * 0.9 + 0.1 * 0.3 + 0.1 * 1;
    expect(floorRisk(f).risk).toBeCloseTo(expected, 9);
  });

  test("every feature on its own contributes exactly its weight", () => {
    expect(floorRisk({ ...ZERO, taint: 1 }).risk).toBeCloseTo(0.35, 9);
    expect(floorRisk({ ...ZERO, scope: 0 }).risk).toBeCloseTo(0.25, 9);
    expect(floorRisk({ ...ZERO, sequence: 1 }).risk).toBeCloseTo(0.2, 9);
    expect(floorRisk({ ...ZERO, environment: 1 }).risk).toBeCloseTo(0.1, 9);
    expect(floorRisk({ ...ZERO, reversibility: 1 }).risk).toBeCloseTo(0.1, 9);
  });

  test("all-zero risk features give 0 (allow) and all-one give 1 (deny)", () => {
    expect(floorRisk(ZERO).risk).toBe(0);
    expect(bandVerdict(floorRisk(ZERO).risk)).toBe("allow");
    expect(floorRisk(ONE).risk).toBe(1);
    expect(bandVerdict(floorRisk(ONE).risk)).toBe("deny");
  });

  test("a sum that is exactly a band boundary is not lost to float drift", () => {
    // 0.25 + 0.1 + 0.1 + 0.05 = 0.5, but the naive float sum is 0.49999999999999994 (annotate)
    const f: Features = { taint: 0, scope: 0, sequence: 0.5, environment: 1, reversibility: 0.5 };
    expect(floorRisk(f).risk).toBe(0.5);
    expect(bandVerdict(floorRisk(f).risk)).toBe("hold");
  });

  test("out-of-range and NaN features are clamped toward risk", () => {
    const wild: Features = {
      taint: Number.NaN,
      scope: Number.NaN,
      sequence: 7,
      environment: -1,
      reversibility: 0,
    };
    expect(floorRisk(wild).risk).toBeCloseTo(0.35 + 0.25 + 0.2, 9);
  });

  test("explains each non-zero term and the total", () => {
    const { why } = floorRisk({ ...ZERO, taint: 1, reversibility: 1 });
    expect(why).toEqual(["taint 1.00 × 0.35", "reversibility 1.00 × 0.10", "floor 0.45"]);
  });

  test("weights come from the policy config", () => {
    const cfg = resolvePolicyConfig({ floor: { weights: { taint: 1 } } });
    expect(floorRisk({ ...ZERO, taint: 0.5 }, cfg).risk).toBeCloseTo(0.5, 9);
    expect(DEFAULT_POLICY_CONFIG.floor.weights.taint).toBe(0.35);
  });
});

describe("bandVerdict (spec bands, D-009)", () => {
  test.each([
    [0, "allow"],
    [0.2999, "allow"],
    [0.3, "annotate"],
    [0.4999, "annotate"],
    [0.5, "hold"],
    [0.8, "hold"],
    [0.8001, "deny"],
    [1, "deny"],
  ] as const)("risk %p → %s", (risk, verdict) => {
    expect(bandVerdict(risk)).toBe(verdict);
  });

  test("NaN fails closed to deny", () => {
    expect(bandVerdict(Number.NaN)).toBe("deny");
  });

  test("bands never produce rewrite or kill", () => {
    const seen = new Set(Array.from({ length: 101 }, (_, i) => bandVerdict(i / 100)));
    expect([...seen].sort()).toEqual(["allow", "annotate", "deny", "hold"]);
  });
});

describe("resolvePolicyConfig", () => {
  test("merges without touching the frozen defaults", () => {
    const cfg = resolvePolicyConfig({ bands: { hold: 0.6 }, judge: { timeoutMs: 50 } });
    expect(cfg.bands).toEqual({ annotate: 0.3, hold: 0.6, deny: 0.8 });
    expect(cfg.judge.timeoutMs).toBe(50);
    expect(cfg.judge.maxQuestions).toBe(4);
    expect(DEFAULT_POLICY_CONFIG.bands.hold).toBe(0.5);
    expect(Object.isFrozen(DEFAULT_POLICY_CONFIG.bands)).toBe(true);
  });

  test("spec numbers: ask band, −0.2 cap, confidence gates, precedent cap, when budget", () => {
    const d = DEFAULT_POLICY_CONFIG;
    expect(d.ask).toMatchObject({ min: 0.3, max: 0.8 });
    expect(d.maxAnswerLowering).toBe(0.2);
    expect(d.confidence).toEqual({ discardBelow: 0.5, trustAbove: 0.8, cap: "hold" });
    expect(d.precedent.maxRiskDelta).toBe(0.3);
    expect(d.when).toMatchObject({ budgetMs: 2, degradeAfter: 3 });
    expect(d.judge).toMatchObject({ timeoutMs: 10_000, maxQuestions: 4 });
  });
});
