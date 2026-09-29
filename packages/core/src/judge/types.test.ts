import { describe, expect, test } from "bun:test";
import { deriveNoulConfidence, scoreLevel } from "./types.ts";
import { validateAnswers, validateQuestions } from "./validate.ts";

describe("deriveNoulConfidence (D-038)", () => {
  test("a calibrated p in [0, 1] is used as is: confidence 1", () => {
    expect(deriveNoulConfidence(0)).toBe(1);
    expect(deriveNoulConfidence(0.2)).toBe(1);
    expect(deriveNoulConfidence(0.5)).toBe(1);
    expect(deriveNoulConfidence(1)).toBe(1);
  });

  test("an unusable p has no confidence, so the answer is discarded", () => {
    expect(deriveNoulConfidence(1.5)).toBe(0);
    expect(deriveNoulConfidence(-2)).toBe(0);
    expect(deriveNoulConfidence(Number.NaN)).toBe(0);
  });
});

describe("scoreLevel", () => {
  const rubric = ["public", "internal", "credential"] as const;

  test("is the rubric label at Math.round(score)", () => {
    expect(scoreLevel(rubric, 0)).toBe("public");
    expect(scoreLevel(rubric, 1.4)).toBe("internal");
    expect(scoreLevel(rubric, 1.5)).toBe("credential");
  });

  test("clamps to the rubric ends", () => {
    expect(scoreLevel(rubric, -3)).toBe("public");
    expect(scoreLevel(rubric, 9)).toBe("credential");
  });

  test("NaN fails toward the top of the rubric", () => {
    expect(scoreLevel(rubric, Number.NaN)).toBe("credential");
  });
});

describe("validateAnswers", () => {
  const noul = { kind: "noul", name: "fits", text: "fits the task" } as const;
  const choice = {
    kind: "choice",
    name: "dest",
    text: "where",
    options: { registry: "a registry", paste: null },
  } as const;
  const score = {
    kind: "score",
    name: "secrecy",
    text: "how secret",
    rubric: ["low", "high"],
  } as const;

  test("accepts well-formed answers of every kind", () => {
    const problems = validateAnswers([noul, choice, score], {
      fits: { kind: "noul", p: 0.9, confidence: 0.8 },
      dest: {
        kind: "choice",
        choice: "registry",
        p: 0.7,
        confidence: 0.6,
        probabilities: { registry: 0.7, paste: 0.3 },
      },
      secrecy: {
        kind: "score",
        score: 1,
        level: "high",
        confidence: 0.9,
        probabilities: { low: 0.1, high: 0.9 },
      },
    });
    expect(problems).toEqual([]);
  });

  test("reports a missing answer, a kind mismatch and out-of-range numbers", () => {
    const problems = validateAnswers([noul, choice, score], {
      dest: { kind: "noul", p: 0.5, confidence: 0 },
      secrecy: { kind: "score", score: 1, level: "high", confidence: 1.2, probabilities: {} },
    });
    expect(problems).toContain("fits: no answer");
    expect(problems).toContain("dest: expected a choice answer, got noul");
    expect(problems).toContain("secrecy: confidence must be in [0, 1]");
  });

  test("rejects a choice outside the options and a level that does not match the score", () => {
    const problems = validateAnswers([choice, score], {
      dest: { kind: "choice", choice: "ftp", p: 1, confidence: 1, probabilities: {} },
      secrecy: { kind: "score", score: 0, level: "high", confidence: 1, probabilities: {} },
    });
    expect(problems).toEqual([
      "dest: choice ftp is not an option",
      "secrecy: level high does not match score 0 (low)",
    ]);
  });
});

describe("validateQuestions", () => {
  test("rejects more than the limit and duplicate names", () => {
    const q = (name: string) => ({ kind: "noul", name, text: "t" }) as const;
    expect(validateQuestions([q("a"), q("b")], 4)).toEqual([]);
    expect(validateQuestions([q("a"), q("b"), q("c")], 2)).toEqual([
      "3 questions asked, at most 2 allowed",
    ]);
    expect(validateQuestions([q("a"), q("a")], 4)).toEqual(["duplicate question name: a"]);
  });

  test("rejects an empty name or text", () => {
    expect(validateQuestions([{ kind: "noul", name: "", text: "" }], 4)).toEqual([
      "question 0: empty name",
      "question 0: empty text",
    ]);
  });
});
