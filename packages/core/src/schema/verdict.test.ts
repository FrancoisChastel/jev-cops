import { describe, expect, test } from "bun:test";
import {
  compareVerdict,
  isDenyClass,
  maxVerdict,
  parseVerdict,
  raiseVerdict,
  VERDICTS,
  type Verdict,
  verdictRank,
} from "./verdict.ts";

type Json = Record<string, unknown>;

/** The spec's verdict response example, with its placeholders filled in. */
function specExample(): Json {
  return {
    schema: "jevdict.verdict/1",
    event_id: "evt_01M3PP723DWGXKY6ZN6TC6ZMXZ",
    verdict: "hold",
    risk: 0.62,
    reason: "Network call to a new host shortly after reading a secret.",
    detail: "curl to api.example.net 40s after reading .env; host not in the task allowlist.",
    updated_input: null,
    context_note: null,
    policies: ["exfil-after-secrets@3"],
    features: { taint: 0.9, scope: 0.2, sequence: 1, environment: 0.3, reversibility: 1 },
    jev: [{ question: "dest_fits_task", type: "noul", p: 0.83, confidence: 0.7 }],
    budget: { spent: 42, limit: 100 },
  };
}

function issuePaths(input: unknown): string[] {
  const result = parseVerdict(input);
  return result.ok ? [] : result.error.issues.map((issue) => issue.path);
}

describe("verdict ladder", () => {
  test("orders the six verdicts from allow to kill", () => {
    expect(VERDICTS).toEqual(["allow", "annotate", "rewrite", "hold", "deny", "kill"]);
    expect(VERDICTS.map(verdictRank)).toEqual([0, 1, 2, 3, 4, 5]);
  });

  test("compareVerdict follows ladder order", () => {
    expect(compareVerdict("allow", "kill")).toBeLessThan(0);
    expect(compareVerdict("deny", "hold")).toBeGreaterThan(0);
    expect(compareVerdict("rewrite", "rewrite")).toBe(0);
  });

  test("maxVerdict is commutative", () => {
    for (const a of VERDICTS) {
      for (const b of VERDICTS) {
        expect(maxVerdict(a, b)).toBe(maxVerdict(b, a));
      }
    }
  });

  test("maxVerdict is idempotent", () => {
    for (const v of VERDICTS) {
      expect(maxVerdict(v, v)).toBe(v);
    }
  });

  test("maxVerdict returns the higher rung", () => {
    expect(maxVerdict("annotate", "deny")).toBe("deny");
    expect(maxVerdict("hold", "allow")).toBe("hold");
  });
});

describe("raiseVerdict", () => {
  test.each([
    ["allow", 0, "allow"],
    ["allow", 1, "annotate"],
    ["annotate", 2, "hold"],
    ["deny", 1, "kill"],
  ] as const)("raises %s by %d to %s", (from, steps, to) => {
    expect(raiseVerdict(from, steps)).toBe(to);
  });

  test("saturates at kill", () => {
    expect(raiseVerdict("hold", 10)).toBe("kill");
    expect(raiseVerdict("kill", 1)).toBe("kill");
  });

  test.each([-1, 0.5, Number.NaN, Number.POSITIVE_INFINITY])(
    "throws on %p steps, since verdicts never move down",
    (steps) => {
      expect(() => raiseVerdict("hold", steps)).toThrow(RangeError);
    },
  );
});

describe("isDenyClass", () => {
  test("is true only for deny and kill", () => {
    const denyClass = VERDICTS.filter((v: Verdict) => isDenyClass(v));
    expect(denyClass).toEqual(["deny", "kill"]);
  });
});

describe("parseVerdict", () => {
  test("round-trips the spec example unchanged", () => {
    const input = specExample();
    const result = parseVerdict(input);
    expect(result).toEqual({ ok: true, value: input as never });
  });

  test("accepts a rewrite carrying updated_input", () => {
    const input = { ...specExample(), verdict: "rewrite", updated_input: { command: "ls -la" } };
    expect(parseVerdict(input).ok).toBe(true);
  });

  test("accepts a response without detail, which the harness must never see", () => {
    const { detail: _detail, ...input } = specExample();
    expect(parseVerdict(input).ok).toBe(true);
  });

  test.each([
    "schema",
    "event_id",
    "verdict",
    "risk",
    "reason",
    "context_note",
    "policies",
    "features",
    "jev",
    "budget",
  ])("rejects a response missing %s", (key) => {
    const input = Object.fromEntries(Object.entries(specExample()).filter(([k]) => k !== key));
    expect(issuePaths(input)).toEqual([key]);
  });

  test.each([
    ["risk", { risk: 1.2 }],
    ["risk", { risk: -0.1 }],
    ["verdict", { verdict: "block" }],
    ["event_id", { event_id: "evt_01J9…" }],
    ["schema", { schema: "jevdict.verdict/2" }],
    ["jev.0.type", { jev: [{ question: "q", type: "yesno", p: 0.5, confidence: 0.5 }] }],
    ["jev.0.p", { jev: [{ question: "q", type: "score", p: 2, confidence: 0.5 }] }],
    ["features.taint", { features: { taint: "high" } }],
    ["budget.limit", { budget: { spent: 1 } }],
    ["extra", { extra: true }],
  ])("rejects a bad %s", (path, override) => {
    expect(issuePaths({ ...specExample(), ...override })).toEqual([path]);
  });

  test("rejects updated_input on a verdict other than rewrite", () => {
    const input = { ...specExample(), verdict: "allow", updated_input: { command: "ls" } };
    expect(issuePaths(input)).toEqual(["updated_input"]);
  });

  test("rejects a rewrite without updated_input", () => {
    expect(issuePaths({ ...specExample(), verdict: "rewrite" })).toEqual(["updated_input"]);
  });

  test("accepts a hold carrying a hold_token, and a hold without one", () => {
    const token = "A".repeat(43);
    expect(parseVerdict({ ...specExample(), hold_token: token })).toEqual({
      ok: true,
      value: { ...specExample(), hold_token: token } as never,
    });
    expect(parseVerdict(specExample()).ok).toBe(true);
  });

  test.each(VERDICTS.filter((v) => v !== "hold" && v !== "rewrite"))(
    "rejects a hold_token on %s: only a hold is resolved by a human",
    (verdict) => {
      expect(issuePaths({ ...specExample(), verdict, hold_token: "b".repeat(43) })).toEqual([
        "hold_token",
      ]);
    },
  );

  test.each([
    ["too short", "c".repeat(42)],
    ["too long", "c".repeat(44)],
    ["not base64url", `${"c".repeat(42)}+`],
    ["empty", ""],
  ])("rejects a hold_token that is %s", (_label, token) => {
    expect(issuePaths({ ...specExample(), hold_token: token })).toEqual(["hold_token"]);
  });

  test.each([
    ["null", null],
    ["undefined", undefined],
    ["a string", "allow"],
    ["an array", []],
    ["a number", 3],
  ])("never throws on %s", (_label, input) => {
    expect(parseVerdict(input).ok).toBe(false);
  });
});
