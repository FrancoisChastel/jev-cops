import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { loadEventFixture } from "../../../tests/fixtures/events/index.ts";
import { defineFixtures, type FixtureCaseInput, loadFixtures, parseFixtures } from "./fixtures.ts";

const TMP = join(import.meta.dir, "..", "testdata");

function file(cases: unknown[]): unknown {
  return { policy: "allow-all", cases };
}

/** A case around the canonical `pre-edit` event; the cast is checked by the schema. */
function allowCase(extra: Record<string, unknown> = {}): FixtureCaseInput {
  return {
    name: "benign edit",
    event: loadEventFixture("pre-edit"),
    expect: { verdict: "allow" },
    ...extra,
  } as FixtureCaseInput;
}

describe("parseFixtures", () => {
  test("accepts a minimal file and defaults nothing it does not need", () => {
    const parsed = parseFixtures(file([allowCase()]));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.policy).toBe("allow-all");
    expect(parsed.value.cases[0]?.expect).toEqual({ verdict: "allow" });
  });

  test("rejects a case without expect.verdict, naming the path", () => {
    const parsed = parseFixtures(file([allowCase({ expect: { policies: ["x"] } })]));
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.error.join("\n")).toContain("cases.0.expect.verdict");
  });

  test("rejects a post event as the judged event", () => {
    const parsed = parseFixtures(file([allowCase({ event: loadEventFixture("post-bash") })]));
    expect(parsed.ok).toBe(false);
  });

  test("accepts pre and post events in history, and recorded answers of every kind", () => {
    const parsed = parseFixtures(
      file([
        allowCase({
          history: [loadEventFixture("pre-bash"), loadEventFixture("post-bash")],
          task: "Fix the flaky test in auth/",
          answers: {
            fits: { kind: "noul", p: 0.9, confidence: 0.9 },
            dest: { kind: "choice", choice: "registry", p: 0.8, confidence: 0.9 },
            secrecy: { kind: "score", score: 0, level: "public", confidence: 0.9 },
          },
          config: { policy: { when: { budgetMs: 10 } } },
          stepMs: 30_000,
        }),
      ]),
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.cases[0]?.history).toHaveLength(2);
    expect(parsed.value.cases[0]?.answers?.dest).toMatchObject({ probabilities: {} });
  });

  test("rejects an answer probability outside [0, 1] and unknown keys", () => {
    const bad = parseFixtures(
      file([allowCase({ answers: { fits: { kind: "noul", p: 2, confidence: 1 } } })]),
    );
    expect(bad.ok).toBe(false);
    const extra = parseFixtures(file([allowCase({ expected: { verdict: "allow" } })]));
    expect(extra.ok).toBe(false);
  });

  test("rejects duplicate case names and an empty case list", () => {
    expect(parseFixtures(file([allowCase(), allowCase()])).ok).toBe(false);
    expect(parseFixtures(file([])).ok).toBe(false);
  });

  test("rejects riskMin above riskMax", () => {
    const parsed = parseFixtures(
      file([allowCase({ expect: { verdict: "allow", riskMin: 0.5, riskMax: 0.2 } })]),
    );
    expect(parsed.ok).toBe(false);
  });
});

describe("defineFixtures", () => {
  test("returns the validated file for authoring fixtures in TypeScript", () => {
    const f = defineFixtures({ policy: "allow-all", cases: [allowCase()] });
    expect(f.cases).toHaveLength(1);
  });

  test("throws with every problem when the file is invalid", () => {
    expect(() => defineFixtures({ policy: "", cases: [] })).toThrow(/policy.*\n?.*cases/s);
  });
});

describe("loadFixtures", () => {
  test("reads and validates a fixture file from disk", async () => {
    const loaded = await loadFixtures(join(TMP, "allow-all.fixtures.json"));
    expect(loaded.ok).toBe(true);
  });

  test("a missing file is an error value, not a throw", async () => {
    const loaded = await loadFixtures(join(TMP, "missing.fixtures.json"));
    expect(loaded.ok).toBe(false);
    if (loaded.ok) return;
    expect(loaded.error[0]).toContain("cannot read");
  });
});
