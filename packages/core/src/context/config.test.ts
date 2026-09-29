import { describe, expect, test } from "bun:test";
import { DEFAULT_CONTEXT_CONFIG, resolveContextConfig } from "./config.ts";

describe("DEFAULT_CONTEXT_CONFIG: spec defaults (D-009)", () => {
  test("budget: 100 points, 10/min decay, cost scale 20, thresholds 0.8 and 1.0", () => {
    const { budget } = DEFAULT_CONTEXT_CONFIG;
    expect(budget.limit).toBe(100);
    expect(budget.decayPerMinute).toBe(10);
    expect(budget.costScale).toBe(20);
    expect(budget.raiseAt).toBe(0.8);
    expect(budget.holdAt).toBe(1.0);
    expect(budget.holdRepeatFactor).toBe(2);
  });

  test("sequence: 5 min window, 2 min secret-then-net window, spec pattern weights", () => {
    const { sequence } = DEFAULT_CONTEXT_CONFIG;
    expect(sequence.windowMs).toBe(5 * 60_000);
    expect(sequence.secretNetWindowMs).toBe(2 * 60_000);
    expect(sequence.weights).toEqual({
      "secret-read-then-net": 1.0,
      "failures-then-privilege": 0.7,
      "write-executable-then-exec": 0.8,
      "new-host-after-secret": 0.9,
    });
  });

  test("environment weights and host classes", () => {
    const { environment } = DEFAULT_CONTEXT_CONFIG;
    expect(environment.weights).toEqual({
      defaultBranch: 0.3,
      cwdOutsideRepo: 0.2,
      dirtyTree: 0.1,
      headless: 0.2,
      noSandbox: 0.1,
    });
    expect(environment.hostClassWeights).toEqual({
      prod: 0.3,
      staging: 0.15,
      dev: 0,
      unknown: 0.05,
    });
    expect(environment.hostClasses).toEqual({});
  });

  test("taint token rules: min length 4, cap 500 per event, tool output fully tainted", () => {
    const { taint } = DEFAULT_CONTEXT_CONFIG;
    expect(taint.minLength).toBe(4);
    expect(taint.maxCandidatesPerEvent).toBe(500);
    expect(taint.outputTaint).toBe(1);
  });

  test("is deeply frozen", () => {
    expect(Object.isFrozen(DEFAULT_CONTEXT_CONFIG)).toBe(true);
    expect(Object.isFrozen(DEFAULT_CONTEXT_CONFIG.budget)).toBe(true);
    expect(Object.isFrozen(DEFAULT_CONTEXT_CONFIG.secrets.pathGlobs)).toBe(true);
  });
});

describe("resolveContextConfig", () => {
  test("no argument returns the defaults", () => {
    expect(resolveContextConfig()).toEqual(DEFAULT_CONTEXT_CONFIG);
  });

  test("deep-merges nested keys and keeps siblings", () => {
    // Act
    const cfg = resolveContextConfig({ home: "/home/dev", budget: { limit: 50 } });

    // Assert
    expect(cfg.home).toBe("/home/dev");
    expect(cfg.budget.limit).toBe(50);
    expect(cfg.budget.decayPerMinute).toBe(10);
    expect(cfg.sequence).toEqual(DEFAULT_CONTEXT_CONFIG.sequence);
  });

  test("merges maps and replaces arrays", () => {
    const cfg = resolveContextConfig({
      environment: { hostClasses: { "api.prod.example": "prod" } },
      scope: { tmpDirs: ["/tmp", "/var/tmp"] },
    });
    expect(cfg.environment.hostClasses).toEqual({ "api.prod.example": "prod" });
    expect(cfg.environment.weights).toEqual(DEFAULT_CONTEXT_CONFIG.environment.weights);
    expect(cfg.scope.tmpDirs).toEqual(["/tmp", "/var/tmp"]);
  });

  test("never mutates the defaults or the partial", () => {
    // Arrange
    const partial = { budget: { limit: 7 } };
    const before = JSON.stringify(DEFAULT_CONTEXT_CONFIG);

    // Act
    const cfg = resolveContextConfig(partial);

    // Assert
    expect(JSON.stringify(DEFAULT_CONTEXT_CONFIG)).toBe(before);
    expect(partial).toEqual({ budget: { limit: 7 } });
    expect(cfg.budget).not.toBe(DEFAULT_CONTEXT_CONFIG.budget);
  });

  test("ignores prototype-polluting keys", () => {
    const hostile = JSON.parse('{"__proto__": {"polluted": true}, "budget": {"limit": 3}}');
    const cfg = resolveContextConfig(hostile);
    expect(cfg.budget.limit).toBe(3);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});
