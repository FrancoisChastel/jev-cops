import { describe, expect, test } from "bun:test";
import {
  answered,
  asking,
  featuresAt,
  fixed,
  noul,
  runCombine,
} from "../../../../tests/fixtures/policy/index.ts";
import type { Answer } from "../judge/types.ts";
import { compareVerdict, parseVerdict, type Verdict } from "../schema/verdict.ts";
import { toVerdictResponse } from "./decision.ts";
import { bandVerdict } from "./floor.ts";
import { SCOPE_QUESTION } from "./questions.ts";
import type { PolicyDefinition } from "./types.ts";

const EPS = 1e-9;
const EVENT_ID = "evt_01M3PP723DWGXKY6ZN6TC6ZMXZ";

/** Answers every question in the batch with the same noul answer. */
function answerAll(answer: Answer) {
  return (plan: { batch: ReadonlyArray<{ name: string }> }) =>
    answered(Object.fromEntries(plan.batch.map((q) => [q.name, answer])));
}

describe("rule 2: monotonic floor", () => {
  test("no model answer lowers the deterministic floor by more than 0.2", () => {
    for (let i = 0; i <= 20; i += 1) {
      const floor = i / 20;
      for (const p of [0, 0.5, 1]) {
        for (const confidence of [0.55, 0.9, 1]) {
          // Arrange
          const scenario = {
            features: featuresAt(floor),
            policies: [asking("permissive", "allow")],
            scopeUnsure: true,
            judge: answerAll(noul(p, confidence)),
          };
          // Act
          const { decision } = runCombine(scenario);
          // Assert
          expect(decision.risk).toBeGreaterThanOrEqual(floor - 0.2 - EPS);
          const lowest = bandVerdict(Math.max(0, floor - 0.2));
          expect(compareVerdict(decision.verdict, lowest)).toBeGreaterThanOrEqual(0);
        }
      }
    }
  });

  test("a model answer can raise risk without limit", () => {
    const { decision } = runCombine({
      features: { taint: 0, scope: 0.5, sequence: 0, environment: 1, reversibility: 1 },
      scopeUnsure: true,
      judge: answerAll(noul(0, 1)),
    });
    expect(decision.floor).toBeCloseTo(0.325, 9);
    expect(decision.flags.scope).toBe("used");
    expect(decision.risk).toBeCloseTo(0.45, 9);
  });

  test("a model answer never turns a deterministic deny into allow", () => {
    // Arrange: floor 0.85 is deny; every answer says "safe" with full confidence
    const judgeCalls: number[] = [];
    const { decision } = runCombine({
      features: featuresAt(0.85),
      policies: [asking("permissive", "allow")],
      scopeUnsure: true,
      judge: (plan) => {
        judgeCalls.push(plan.batch.length);
        return answerAll(noul(1, 1))(plan);
      },
    });
    // Assert
    expect(decision.verdict).toBe("deny");
    expect(decision.risk).toBeGreaterThanOrEqual(0.85);
    expect(judgeCalls).toEqual([]);
    expect(decision.trace[0]).toMatchObject({ fallbackUsed: true, verdict: "deny" });
  });

  test("a scope answer at the band edge lowers risk by exactly the cap and no more", () => {
    const { decision } = runCombine({
      features: featuresAt(0.8),
      scopeUnsure: true,
      judge: answerAll(noul(1, 1)),
    });
    expect(decision.floor).toBe(0.8);
    expect(decision.risk).toBeCloseTo(0.6, 9);
    expect(decision.verdict).toBe("hold");
  });
});

describe("rule 1: questions only in the uncertain band", () => {
  test.each([
    [0.29, false],
    [0.3, true],
    [0.55, true],
    [0.8, true],
    [0.81, false],
  ])(
    "questions are asked only when the floor is in the uncertain band (floor %p)",
    (floor, asked) => {
      const { plan, decision } = runCombine({
        features: featuresAt(floor),
        policies: [asking("q")],
        judge: answerAll(noul(1, 1)),
      });
      expect(plan.inBand).toBe(asked);
      expect(decision.flags.inBand).toBe(asked);
      expect(plan.batch.length > 0).toBe(asked);
      expect(decision.trace[0]?.asked).toBe(asked);
    },
  );

  test("a policy with ask that was not asked takes its fallback, else the floor band", () => {
    const low = runCombine({ features: featuresAt(0.1), policies: [asking("q")] }).decision;
    expect(low.trace[0]).toMatchObject({ fallbackUsed: true, verdict: "allow" });
    const withFallback = runCombine({
      features: featuresAt(0.1),
      policies: [{ ...asking("q"), fallback: "hold" }],
    }).decision;
    expect(withFallback.verdict).toBe("hold");
  });

  test("a policy without ask decides with no answers, in or out of band", () => {
    const { decision } = runCombine({ features: featuresAt(0.9), policies: [fixed("k", "kill")] });
    expect(decision.verdict).toBe("kill");
    expect(decision.trace[0]).toMatchObject({ asked: false, fallbackUsed: false, verdict: "kill" });
  });
});

describe("rule 3: confidence routing", () => {
  test("answer confidence below 0.5 is discarded and the floor stands", () => {
    // Arrange: floor 0.6 (hold); a confident-looking "safe" with confidence 0.49
    const { decision } = runCombine({
      features: featuresAt(0.6),
      policies: [asking("q", "deny")],
      scopeUnsure: true,
      judge: answerAll(noul(1, 0.49)),
    });
    // Assert
    expect(decision.verdict).toBe("hold");
    expect(decision.risk).toBe(0.6);
    expect(decision.flags.scope).toBe("discarded");
    expect(decision.trace[0]).toMatchObject({ fallbackUsed: true, verdict: "hold" });
    expect(decision.trace[0]?.note).toContain("discarded");
  });

  test("answer confidence between 0.5 and 0.8 caps the policy verdict at hold", () => {
    const secrecy: PolicyDefinition = {
      ...fixed("secrecy", "kill"),
      ask: () => [{ kind: "noul", name: "credential", text: "Is the payload a credential?" }],
      decide: (_e, _c, a) => ((a.credential as { p: number }).p > 0.5 ? "kill" : "annotate"),
    };
    const run = (confidence: number) =>
      runCombine({
        features: featuresAt(0.5),
        policies: [secrecy],
        judge: answerAll(noul(0.99, confidence)),
      }).decision;
    expect(run(0.5)).toMatchObject({ verdict: "hold", trace: [{ capped: true }] });
    expect(run(0.65).verdict).toBe("hold");
    expect(run(0.8).verdict).toBe("hold");
    expect(run(0.81)).toMatchObject({ verdict: "kill", trace: [{ capped: false }] });
  });

  test("a mid-confidence answer never lowers a verdict below its policy's decision", () => {
    const { decision } = runCombine({
      features: featuresAt(0.5),
      policies: [asking("q", "annotate")],
      judge: answerAll(noul(0.1, 0.6)),
    });
    expect(decision.trace[0]).toMatchObject({ verdict: "annotate", capped: false });
  });
});

describe("rule 4: timeouts", () => {
  test("judge timeout counts as no answer and the floor stands", () => {
    // Arrange
    const { decision } = runCombine({
      features: featuresAt(0.55),
      policies: [asking("q", "allow")],
      scopeUnsure: true,
      judge: () => ({
        ok: false,
        error: "timeout",
        detail: "no answer within 10000 ms",
        latencyMs: 1e4,
      }),
    });
    // Assert
    expect(decision.verdict).toBe("hold");
    expect(decision.risk).toBe(0.55);
    expect(decision.jev).toEqual([]);
    expect(decision.flags.judge).toBe("timeout");
    expect(decision.trace[0]).toMatchObject({ asked: true, answered: false, fallbackUsed: true });
  });

  test.each(["unreachable", "invalid", "disabled"] as const)(
    "judge %s: the floor stands",
    (error) => {
      const { decision } = runCombine({
        features: featuresAt(0.55),
        policies: [asking("q", "allow")],
        judge: () => ({ ok: false, error, detail: "x", latencyMs: 0 }),
      });
      expect(decision.verdict).toBe("hold");
      expect(decision.flags.judge).toBe(error);
    },
  );
});

describe("monotonic combination across policies", () => {
  test("a later policy can raise but never lower an earlier verdict", () => {
    const f = featuresAt(0.1);
    const verdictOf = (...vs: Verdict[]) =>
      runCombine({ features: f, policies: vs.map((v, i) => fixed(`p${i}`, v)) }).decision.verdict;
    expect(verdictOf("deny", "allow")).toBe("deny");
    expect(verdictOf("allow", "deny")).toBe("deny");
    expect(verdictOf("kill", "hold", "allow")).toBe("kill");
    expect(verdictOf("annotate", "hold")).toBe("hold");
  });

  test("a policy returning allow never lowers the floor band", () => {
    const { decision } = runCombine({ features: featuresAt(0.6), policies: [fixed("a", "allow")] });
    expect(decision.verdict).toBe("hold");
  });

  test("decide is clamped into the declared range", () => {
    const low = fixed("ranged", "allow", { range: ["hold", "deny"] });
    const high = fixed("capped", "kill", { range: ["annotate", "hold"] });
    expect(runCombine({ features: featuresAt(0), policies: [low] }).decision.verdict).toBe("hold");
    expect(runCombine({ features: featuresAt(0), policies: [high] }).decision.verdict).toBe("hold");
  });

  test("a decide that throws or returns garbage fails toward hold", () => {
    const threw = fixed("threw", "allow", {
      decide: () => {
        throw new Error("oops");
      },
    });
    const garbage = fixed("garbage", "allow", { decide: () => "maybe" as Verdict });
    for (const p of [threw, garbage]) {
      const { decision } = runCombine({ features: featuresAt(0), policies: [p] });
      expect(decision.verdict).toBe("hold");
      expect(decision.trace[0]?.note).toContain("decide");
    }
  });

  test("the reason is the winning policy's; otherwise the fixed band reason", () => {
    const won = runCombine({ features: featuresAt(0), policies: [fixed("a", "deny")] }).decision;
    expect(won.reason).toBe("a says deny.");
    const band = runCombine({ features: featuresAt(0.6), policies: [fixed("a", "annotate")] });
    expect(band.decision.reason).toBe(
      "This action is risky in the current context and needs a human decision.",
    );
  });

  test("an agent-facing reason is one bounded line", () => {
    const noisy = fixed("noisy", "deny", { reason: `line one\nline two\t${"x".repeat(1_000)}` });
    const { decision } = runCombine({ features: featuresAt(0), policies: [noisy] });
    expect(decision.reason).not.toContain("\n");
    expect(decision.reason.length).toBeLessThanOrEqual(300);
  });
});

describe("risk budget", () => {
  test("budget at 80 percent raises every verdict one step", () => {
    // Arrange: 79 spent + cost of this event (>= 1) crosses 80
    const at = (floor: number, kind: "exec" | "fs.read" = "exec") =>
      runCombine({ features: featuresAt(floor), spent: 79, kind }).decision;
    // Assert
    expect(at(0.05)).toMatchObject({ verdict: "annotate", flags: { budgetRaised: true } });
    expect(at(0.05).context_note).toBe(
      "Most of this session's risk budget is spent; further risky actions will be held.",
    );
    expect(at(0.6).verdict).toBe("deny");
    expect(at(0.9).verdict).toBe("kill");
    // annotate → rewrite has no payload, so it is raised to hold
    expect(at(0.35)).toMatchObject({ verdict: "hold", flags: { rewriteWithoutInput: true } });
  });

  test("budget at 100 percent holds every non-trivial action", () => {
    const exec = runCombine({ features: featuresAt(0), spent: 100 }).decision;
    expect(exec).toMatchObject({ verdict: "hold", flags: { budgetHeld: true } });
    expect(exec.reason).toBe(
      "The session's risk budget is exhausted; a human must review further actions.",
    );
    const read = runCombine({ features: featuresAt(0), spent: 100, kind: "fs.read" }).decision;
    expect(read).toMatchObject({ verdict: "annotate", flags: { budgetHeld: false } });
  });

  test("the event is charged round(risk · 20) and a hold adds the repeat surcharge", () => {
    const { decision } = runCombine({ features: featuresAt(0.6), spent: 10 });
    expect(decision.verdict).toBe("hold");
    expect(decision.budget).toEqual({ spent: 22, limit: 100 });
    expect(decision.nextBudget.holds).toEqual({ "exec:rm": 1 });
  });
});

describe("precedents", () => {
  test("a precedent lowers risk by at most 0.3 and never bypasses kill", () => {
    // Arrange: delta 0.9 is capped to 0.3
    const lowered = runCombine({
      features: featuresAt(0.7),
      policies: [fixed("guard", "hold")],
      precedent: { key: "exec:rm", riskDelta: 0.9, policies: ["guard"] },
    }).decision;
    // Assert
    expect(lowered.risk).toBeCloseTo(0.4, 9);
    expect(lowered.verdict).toBe("annotate");
    expect(lowered.flags.precedent).toBe("applied");
    expect(lowered.trace[0]).toMatchObject({ waived: true });

    const killed = runCombine({
      features: featuresAt(0.7),
      policies: [fixed("tamper", "kill")],
      precedent: { key: "exec:rm", riskDelta: 0.3, policies: ["tamper"] },
    }).decision;
    expect(killed.verdict).toBe("kill");
    expect(killed.risk).toBe(0.7);
    expect(killed.flags.precedent).toBe("ignored-kill");
  });

  test("a precedent never waives a deny from a policy it does not name, or any deny", () => {
    const { decision } = runCombine({
      features: featuresAt(0.3),
      policies: [fixed("named", "deny"), fixed("other", "hold")],
      precedent: { key: "k", riskDelta: 0.3, policies: ["named"] },
    });
    expect(decision.verdict).toBe("deny");
    expect(decision.trace.map((t) => t.waived)).toEqual([false, false]);
  });
});

describe("rewrite and annotate payloads", () => {
  test("rewrite without updated_input is raised to hold", () => {
    const { decision } = runCombine({
      features: featuresAt(0),
      policies: [fixed("rw", "rewrite")],
    });
    expect(decision.verdict).toBe("hold");
    expect(decision.updated_input).toBeNull();
    expect(decision.flags.rewriteWithoutInput).toBe(true);
    expect(decision.reason).toBe(
      "A safer form of this action could not be produced; a human must review it.",
    );
  });

  test("a rewrite with a payload carries it as updated_input", () => {
    const pin = fixed("pin", "rewrite", {
      rewrite: (e) => ({ ...e.call.input, command: "rm -rf /work/repo/build" }),
    });
    const { decision } = runCombine({ features: featuresAt(0), policies: [pin] });
    expect(decision.verdict).toBe("rewrite");
    expect(decision.updated_input).toEqual({ command: "rm -rf /work/repo/build" });
  });

  test("two policies rewriting differently are raised to hold", () => {
    const a = fixed("a", "rewrite", { rewrite: () => ({ command: "a" }) });
    const b = fixed("b", "rewrite", { rewrite: () => ({ command: "b" }) });
    const { decision } = runCombine({ features: featuresAt(0), policies: [a, b] });
    expect(decision.verdict).toBe("hold");
  });

  test("annotate carries the policy's context note, else the default note", () => {
    const noted = fixed("n", "annotate", { contextNote: () => "First contact with this host." });
    expect(runCombine({ features: featuresAt(0), policies: [noted] }).decision.context_note).toBe(
      "First contact with this host.",
    );
    expect(runCombine({ features: featuresAt(0.35) }).decision.context_note).toBe(
      "jev-cops flagged this action as moderately risky; stay within the task.",
    );
    expect(runCombine({ features: featuresAt(0.6) }).decision.context_note).toBeNull();
  });
});

describe("decision output", () => {
  test("records asked answers as jev entries with qualified names", () => {
    const { decision } = runCombine({
      features: featuresAt(0.5),
      policies: [asking("q")],
      scopeUnsure: true,
      judge: answerAll(noul(0.9, 0.85)),
    });
    expect(decision.jev).toEqual([
      { question: "q/safe", type: "noul", p: 0.9, confidence: 0.85 },
      { question: SCOPE_QUESTION, type: "noul", p: 0.9, confidence: 0.85 },
    ]);
    expect(decision.policies).toEqual(["q@1"]);
  });

  test("detail explains the floor, the judge and every matched policy", () => {
    const { decision } = runCombine({
      features: featuresAt(0.6),
      policies: [asking("q"), fixed("unmatched", "kill", { when: () => false })],
      judge: () => ({ ok: false, error: "timeout", detail: "x", latencyMs: 1 }),
    });
    expect(decision.detail).toContain("floor 0.60");
    expect(decision.detail).toContain("judge: timeout");
    expect(decision.detail).toContain("q@1: hold (fallback");
    expect(decision.detail).not.toContain("unmatched@1:");
    expect(decision.policies).toEqual(["q@1"]);
  });

  test.each([
    ["allow", featuresAt(0), []],
    ["annotate", featuresAt(0.35), []],
    ["hold", featuresAt(0.6), []],
    ["kill", featuresAt(0.9), [fixed("k", "kill")]],
  ] as const)(
    "decision converts to a valid jev-cops.verdict/1 (%s)",
    (verdict, features, policies) => {
      const { decision } = runCombine({ features, policies: [...policies] });
      const response = toVerdictResponse(decision, EVENT_ID);
      expect(response.verdict).toBe(verdict);
      const parsed = parseVerdict(response);
      expect(parsed.ok).toBe(true);
    },
  );

  test("decision converts to a valid jev-cops.verdict/1 (rewrite with jev answers)", () => {
    const pin = { ...asking("pin", "rewrite"), rewrite: () => ({ command: "ls" }) };
    const { decision } = runCombine({
      features: featuresAt(0.4),
      policies: [pin],
      judge: answerAll(noul(0.1, 0.95)),
    });
    const parsed = parseVerdict(toVerdictResponse(decision, EVENT_ID));
    expect(parsed.ok && parsed.value).toMatchObject({
      verdict: "rewrite",
      updated_input: { command: "ls" },
      jev: [{ question: "pin/safe", type: "noul" }],
    });
  });
});
