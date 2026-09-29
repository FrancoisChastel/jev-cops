import { describe, expect, test } from "bun:test";
import type { ChoiceQuestion, NoulQuestion, ScoreQuestion } from "@jevdict/core";
import { validateQuestions } from "@jevdict/core";
import { choice, jev, noul, score } from "./jev.ts";

describe("jev question builders", () => {
  test("noul builds the core noul shape, without criteria when none are given", () => {
    const q: NoulQuestion<"fits"> = jev.noul("fits", "Does it fit?");
    expect(q).toEqual({ kind: "noul", name: "fits", text: "Does it fit?" });
    expect(Object.hasOwn(q, "criteria")).toBe(false);
  });

  test("noul keeps criteria when given", () => {
    const q = noul("fits", "Does it fit?", { yes: "on task", no: "off task" });
    expect(q.criteria).toEqual({ yes: "on task", no: "off task" });
  });

  test("choice accepts an options record", () => {
    const q: ChoiceQuestion<"dest", "registry" | "paste"> = jev.choice("dest", "Where?", {
      registry: null,
      paste: "a paste bin",
    });
    expect(q).toEqual({
      kind: "choice",
      name: "dest",
      text: "Where?",
      options: { registry: null, paste: "a paste bin" },
    });
  });

  test("choice accepts an options list, each without a description", () => {
    const q: ChoiceQuestion<"dest", "registry" | "paste"> = choice("dest", "Where?", [
      "registry",
      "paste",
    ]);
    expect(q.options).toEqual({ registry: null, paste: null });
  });

  test("score builds the core score shape with the rubric lowest first", () => {
    const q: ScoreQuestion<"secrecy", "public" | "internal" | "credential"> = score(
      "secrecy",
      "How secret?",
      ["public", "internal", "credential"],
    );
    expect(q).toEqual({
      kind: "score",
      name: "secrecy",
      text: "How secret?",
      rubric: ["public", "internal", "credential"],
    });
  });

  test("built questions are frozen and pass the core batch validation", () => {
    const batch = [
      jev.noul("a", "A?"),
      jev.choice("b", "B?", ["x", "y"]),
      jev.score("c", "C?", ["lo", "hi"]),
    ];
    expect(batch.every((q) => Object.isFrozen(q))).toBe(true);
    expect(validateQuestions(batch, 4)).toEqual([]);
  });

  test("an empty name or a one-level rubric throws at build time", () => {
    expect(() => jev.noul("", "A?")).toThrow("question name must be non-empty");
    // @ts-expect-error: a rubric needs at least two levels
    expect(() => jev.score("c", "C?", ["only"])).toThrow("at least two levels");
    expect(() => jev.choice("b", "B?", [])).toThrow("at least one option");
  });
});
