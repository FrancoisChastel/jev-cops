import { describe, expect, test } from "bun:test";
import type { ChoiceQuestion, ScoreQuestion } from "@jevdict/core";
import {
  collectAnswers,
  normalizeProbabilities,
  PROBABILITY_SUM_TOLERANCE,
  readChoice,
  readDerivedNoul,
  readReportedNoul,
  readScore,
} from "./answers.ts";
import { CHOICE, NOUL, QUESTIONS, SCORE } from "./testing/fixtures.ts";

const choiceQ = CHOICE as ChoiceQuestion;
const scoreQ = SCORE as ScoreQuestion;

describe("normalizeProbabilities", () => {
  test("a distribution that sums to 1 is kept as is", () => {
    const result = normalizeProbabilities("q", { a: 0.25, b: 0.75 }, ["a", "b"]);
    expect(result).toEqual({ ok: true, value: { a: 0.25, b: 0.75 } });
  });

  test("a sum within the tolerance is rescaled to 1", () => {
    // Arrange: 0.6 + 0.35 = 0.95
    const raw = { a: 0.6, b: 0.35 };
    // Act
    const result = normalizeProbabilities("q", raw, ["a", "b"]);
    // Assert
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.a).toBeCloseTo(0.6 / 0.95, 9);
    expect((result.value.a ?? 0) + (result.value.b ?? 0)).toBeCloseTo(1, 9);
  });

  test("a sum outside the tolerance is not a distribution", () => {
    const over = 1 + PROBABILITY_SUM_TOLERANCE + 0.01;
    const result = normalizeProbabilities("q", { a: over / 2, b: over / 2 }, ["a", "b"]);
    expect(result).toMatchObject({ ok: false });
    expect(!result.ok && result.error).toContain("sum");
  });

  test("a missing, unknown, NaN, negative or zero-sum entry is rejected", () => {
    const keys = ["a", "b"];
    expect(normalizeProbabilities("q", { a: 1 }, keys).ok).toBe(false);
    expect(normalizeProbabilities("q", { a: 0.5, b: 0.5, c: 0 }, keys).ok).toBe(false);
    expect(normalizeProbabilities("q", { a: Number.NaN, b: 1 }, keys).ok).toBe(false);
    expect(normalizeProbabilities("q", { a: -0.1, b: 1.1 }, keys).ok).toBe(false);
    expect(normalizeProbabilities("q", { a: 0, b: 0 }, keys).ok).toBe(false);
    expect(normalizeProbabilities("q", [0.5, 0.5], keys).ok).toBe(false);
  });
});

describe("noul readers", () => {
  test("a calibrated p is used as is with confidence 1 (D-038)", () => {
    expect(readDerivedNoul("q", 0.9)).toEqual({
      ok: true,
      value: { kind: "noul", p: 0.9, confidence: 1 },
    });
    expect(readDerivedNoul("q", 0.5)).toEqual({
      ok: true,
      value: { kind: "noul", p: 0.5, confidence: 1 },
    });
  });

  test("a reported confidence is taken as given, not capped by p", () => {
    const high = readReportedNoul("q", 0.55, 0.99);
    const low = readReportedNoul("q", 0.9, 0.3);
    expect(high.ok && high.value.confidence).toBe(0.99);
    expect(low.ok && low.value.confidence).toBe(0.3);
  });

  test("p or confidence outside [0, 1] is rejected", () => {
    expect(readDerivedNoul("q", 1.2).ok).toBe(false);
    expect(readDerivedNoul("q", "0.9").ok).toBe(false);
    expect(readReportedNoul("q", 0.9, Number.NaN).ok).toBe(false);
    expect(readReportedNoul("q", 0.9, undefined).ok).toBe(false);
  });
});

describe("readChoice", () => {
  test("p is the normalized probability of the chosen option", () => {
    const raw = {
      choice: "exfil",
      confidence: 0.9,
      probabilities: { task: 0, explore: 0.2, exfil: 0.8 },
    };
    const result = readChoice(choiceQ, raw);
    expect(result).toEqual({
      ok: true,
      value: {
        kind: "choice",
        choice: "exfil",
        p: 0.8,
        confidence: 0.9,
        probabilities: { task: 0, explore: 0.2, exfil: 0.8 },
      },
    });
  });

  test("a label that is not an option is rejected", () => {
    const raw = {
      choice: "bogus",
      confidence: 0.9,
      probabilities: { task: 0.1, explore: 0.1, exfil: 0.8 },
    };
    const result = readChoice(choiceQ, raw);
    expect(!result.ok && result.error).toContain("bogus");
  });

  test("an inherited property name is not an option", () => {
    const raw = {
      choice: "toString",
      confidence: 0.9,
      probabilities: { task: 0.1, explore: 0.1, exfil: 0.8 },
    };
    expect(readChoice(choiceQ, raw).ok).toBe(false);
  });
});

describe("readScore", () => {
  test("level is the rubric label at round(score)", () => {
    const raw = { score: 1.4, confidence: 0.7, probabilities: { "0": 0.2, "1": 0.2, "2": 0.6 } };
    const result = readScore(scoreQ, raw);
    expect(result).toMatchObject({ ok: true, value: { kind: "score", score: 1.4, level: "low" } });
  });

  test("a score outside the rubric is rejected", () => {
    const raw = { score: 3, confidence: 0.7, probabilities: { "0": 0.2, "1": 0.2, "2": 0.6 } };
    expect(readScore(scoreQ, raw).ok).toBe(false);
  });
});

describe("collectAnswers", () => {
  const read = (_q: unknown, raw: unknown) => readDerivedNoul("x", raw);

  test("a question without an answer makes the whole batch fail", () => {
    const result = collectAnswers([NOUL], {}, read);
    expect(!result.ok && result.error).toContain(`${NOUL.name}: no answer`);
  });

  test("a non-object payload fails without throwing", () => {
    for (const payload of [null, 42, "x", [1]]) {
      expect(collectAnswers(QUESTIONS, payload, read).ok).toBe(false);
    }
  });

  test("answers to names that were not asked are dropped", () => {
    const result = collectAnswers([NOUL], { [NOUL.name]: 0.9, other: 0.1 }, read);
    expect(result.ok && Object.keys(result.value)).toEqual([NOUL.name]);
  });
});
