import { describe, expect, test } from "bun:test";
import { createDisabledJudge, createMockJudge } from "./mock.ts";
import type { Answer, JudgeState, Question } from "./types.ts";

const STATE: JudgeState = {
  stateHash: "a".repeat(64),
  tool: "Bash",
  kind: "net",
  command: "curl https://example.com",
  raw: "curl https://example.com",
  verbs: ["curl"],
  paths: [],
  hosts: ["example.com"],
  opaque: [],
  features: { taint: 0, scope: 0.5, sequence: 0, environment: 0.1, reversibility: 0 },
  task: "Fix the flaky test in auth/",
  casefile: { recentCalls: [], secretReads: 0, hostsSeen: [] },
};

const FITS: Question = { kind: "noul", name: "fits", text: "The host fits the task" };
const YES: Answer = { kind: "noul", p: 0.9, confidence: 0.8 };

describe("createMockJudge", () => {
  test("returns the scripted answers for the asked questions", async () => {
    // Arrange
    const judge = createMockJudge({ fits: YES, unused: YES });
    // Act
    const result = await judge.ask(STATE, [FITS]);
    // Assert
    expect(result).toMatchObject({ ok: true, answers: { fits: YES }, provider: "mock" });
    expect(result.ok && Object.keys(result.answers)).toEqual(["fits"]);
    expect(result.ok && result.cached).toBe(false);
  });

  test("a script function sees the state and the questions", async () => {
    const seen: string[] = [];
    const judge = createMockJudge((state, questions) => {
      seen.push(state.command, ...questions.map((q) => q.name));
      return { fits: YES };
    });
    await judge.ask(STATE, [FITS]);
    expect(seen).toEqual(["curl https://example.com", "fits"]);
  });

  test("an unknown question name is reported as invalid", async () => {
    const judge = createMockJudge({ fits: YES });
    const other: Question = { kind: "noul", name: "other", text: "?" };
    const result = await judge.ask(STATE, [FITS, other]);
    expect(result).toMatchObject({ ok: false, error: "invalid" });
    expect(!result.ok && result.detail).toContain("other");
  });

  test("an answer of the wrong kind is invalid", async () => {
    const score: Question = { kind: "score", name: "fits", text: "?", rubric: ["lo", "hi"] };
    const result = await createMockJudge({ fits: YES }).ask(STATE, [score]);
    expect(result).toMatchObject({ ok: false, error: "invalid" });
  });

  test("a scripted failure is returned as that error", async () => {
    const result = await createMockJudge({ fits: YES }, { fail: "unreachable" }).ask(STATE, [FITS]);
    expect(result).toMatchObject({ ok: false, error: "unreachable" });
  });

  test("a delayed mock stops waiting when the signal aborts", async () => {
    const judge = createMockJudge({ fits: YES }, { delayMs: 5_000 });
    const controller = new AbortController();
    const pending = judge.ask(STATE, [FITS], { signal: controller.signal });
    controller.abort();
    const result = await pending;
    expect(result).toMatchObject({ ok: false, error: "timeout" });
    expect(result.latencyMs).toBeLessThan(1_000);
  });

  test("returned answers are copies: mutating them never changes the script", async () => {
    const script = { fits: { kind: "noul", p: 0.9, confidence: 0.8 } } as const;
    const judge = createMockJudge(script);
    const first = await judge.ask(STATE, [FITS]);
    if (first.ok) (first.answers.fits as { p: number }).p = 0;
    const second = await judge.ask(STATE, [FITS]);
    expect(second.ok && second.answers.fits).toEqual(YES);
  });
});

describe("createDisabledJudge", () => {
  test("always answers disabled, the feature-flag-off case", async () => {
    const result = await createDisabledJudge().ask(STATE, [FITS]);
    expect(result).toMatchObject({ ok: false, error: "disabled", latencyMs: 0 });
  });
});
