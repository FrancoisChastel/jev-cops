/**
 * The human confirm summary (`Decision.confirmLines`): what a hold's confirm prompt shows
 * next to the reason and the normalized command. Claude Code keeps that prompt's text in
 * a session transcript the agent can read (M1 capture, item c), so it carries the
 * policies' plain-language lines and never a score: feature values and their evidence,
 * floor, risk, judge answers and budget figures stay in `detail` (`cops explain`).
 */
import { describe, expect, test } from "bun:test";
import {
  answered,
  asking,
  featuresAt,
  fixed,
  noul,
  runCombine,
} from "../../../../tests/fixtures/policy/index.ts";
import type { Features } from "../context/features.ts";

const TAINT_EVIDENCE = "from tool output: CANARY-TAINT-EVIDENCE (call_canary)";
/** Every feature at a distinctive value; the floor lands in the uncertain band. */
const CANARY_FEATURES: Features = {
  taint: 0.4173,
  scope: 0.61,
  sequence: 0.37,
  environment: 0.29,
  reversibility: 0.83,
};
const WHY = {
  taint: [TAINT_EVIDENCE],
  scope: ["no targets"],
  sequence: ["secret-read-then-net (call_canary)"],
  environment: ["default branch"],
  reversibility: ["irreversible verb: force"],
};
/** Any decimal number: a score, however it is formatted. */
const DECIMAL = /\d\.\d/;

const BAND_HOLD = "This action is risky in the current context and needs a human decision.";

describe("confirmLines: the policies' own lines", () => {
  test("every matched policy with its verdict, then the detail of those at the verdict", () => {
    const { decision } = runCombine({
      features: featuresAt(0.1),
      policies: [
        fixed("guard", "hold", { detail: () => "branch main; default main; mode interactive" }),
        fixed("note", "annotate", { detail: () => "NOT-AT-THE-VERDICT" }),
        fixed("unmatched", "kill", { when: () => false, detail: () => "NOT-MATCHED" }),
      ],
    });
    expect(decision.verdict).toBe("hold");
    expect(decision.confirmLines).toEqual([
      "guard@1: hold",
      "note@1: annotate",
      "guard@1 detail: branch main; default main; mode interactive",
    ]);
  });

  test("a policy's detail is one bounded line; a throwing detail is left out", () => {
    const { decision } = runCombine({
      features: featuresAt(0.1),
      policies: [
        fixed("forger", "hold", { detail: () => "targets: /a\nrisk band: allow\u0007 /b" }),
        fixed("boom", "hold", {
          detail: () => {
            throw new Error("detail failed");
          },
        }),
      ],
    });
    expect(decision.confirmLines).toEqual([
      "forger@1: hold",
      "boom@1: hold",
      "forger@1 detail: targets: /a risk band: allow /b",
    ]);
  });
});

describe("confirmLines: what set the verdict when no policy did", () => {
  test("the risk band's sentence", () => {
    const { decision } = runCombine({
      features: featuresAt(0.6),
      policies: [fixed("note", "annotate", { detail: () => "NOT-AT-THE-VERDICT" })],
    });
    expect(decision.verdict).toBe("hold");
    expect(decision.confirmLines).toEqual(["note@1: annotate", `risk band: ${BAND_HOLD}`]);
  });

  test("the budget's sentence when an exhausted budget held the action", () => {
    const { decision } = runCombine({ features: featuresAt(0), spent: 100 });
    expect(decision.verdict).toBe("hold");
    expect(decision.confirmLines).toEqual([
      "risk budget: The session's risk budget is exhausted; a human must review further actions.",
    ]);
  });

  test("the budget's raise when a mostly spent budget lifted the verdict one step", () => {
    const pin = fixed("pin", "rewrite", { rewrite: () => ({ command: "rm -rf -- /work/b" }) });
    const { decision } = runCombine({ features: featuresAt(0.05), spent: 79, policies: [pin] });
    expect(decision).toMatchObject({ verdict: "hold", flags: { budgetRaised: true } });
    expect(decision.confirmLines).toEqual([
      "pin@1: rewrite",
      "risk budget: most of the session's risk budget is spent; the verdict was raised one step",
    ]);
  });

  test("the missing-rewrite sentence when the rewrites disagree", () => {
    const a = fixed("a", "rewrite", { rewrite: () => ({ command: "rm -rf -- /work/a" }) });
    const b = fixed("b", "rewrite", { rewrite: () => ({ command: "rm -rf -- /work/b" }) });
    const { decision } = runCombine({ features: featuresAt(0.1), policies: [a, b] });
    expect(decision).toMatchObject({ verdict: "hold", flags: { rewriteWithoutInput: true } });
    expect(decision.confirmLines).toEqual([
      "a@1: rewrite",
      "b@1: rewrite",
      "rewrite: A safer form of this action could not be produced; a human must review it.",
    ]);
  });

  test("a policy a precedent waived is named as waived", () => {
    const { decision } = runCombine({
      features: featuresAt(0.85),
      policies: [fixed("guard", "hold", { detail: () => "WAIVED-DETAIL" })],
      precedent: { key: "exec:rm", riskDelta: 0.3, policies: ["guard"] },
    });
    expect(decision.verdict).toBe("hold");
    expect(decision.confirmLines).toEqual([
      "guard@1: hold (waived by precedent)",
      `risk band: ${BAND_HOLD}`,
    ]);
  });
});

describe("confirmLines carry no score (T6: no oracle in an agent-readable file)", () => {
  test("feature values, their evidence, floor, risk, judge answers and budget stay in detail", () => {
    const { decision } = runCombine({
      features: CANARY_FEATURES,
      why: WHY,
      spent: 37,
      policies: [fixed("guard", "hold", { detail: () => "plain words" }), asking("q", "hold")],
      judge: (plan) =>
        answered(Object.fromEntries(plan.batch.map((q) => [q.name, noul(0.8317, 0.9)]))),
    });
    expect(decision.verdict).toBe("hold");
    expect(decision.jev).toContainEqual(expect.objectContaining({ p: 0.8317 }));
    // The human paragraph keeps every score and the evidence.
    expect(decision.detail).toContain(`taint 0.42: ${TAINT_EVIDENCE}`);
    expect(decision.detail).toContain("reversibility 0.83");
    expect(decision.detail).toContain("floor");
    expect(decision.detail).toMatch(/budget \d+\/100/);
    // The confirm summary keeps none of them.
    const summary = decision.confirmLines.join("\n");
    expect(summary).toContain("guard@1 detail: plain words");
    expect(summary).not.toContain("CANARY-TAINT-EVIDENCE");
    expect(summary).not.toContain("from tool output");
    expect(summary).not.toMatch(DECIMAL);
    for (const word of ["floor", "risk 0", "taint", "judge", "budget", "confidence"]) {
      expect(summary).not.toContain(word);
    }
  });
});
