import { describe, expect, test } from "bun:test";
import { DEFAULT_JUDGE_CONFIG } from "./config.ts";
import { composeJudge, withQuestionLimit, withTimeout, withValidation } from "./guard.ts";
import { createMockJudge } from "./mock.ts";
import type { Answer, Judge, JudgeResult, JudgeState, Question } from "./types.ts";

const STATE: JudgeState = {
  stateHash: "d".repeat(64),
  tool: "Bash",
  kind: "exec",
  command: "ls",
  raw: "ls",
  verbs: ["ls"],
  paths: [],
  hosts: [],
  opaque: [],
  features: { taint: 0, scope: 0.7, sequence: 0, environment: 0, reversibility: 0 },
  task: null,
  casefile: { recentCalls: [], secretReads: 0, hostsSeen: [] },
};
const q = (name: string): Question => ({ kind: "noul", name, text: `question ${name}` });
const YES: Answer = { kind: "noul", p: 0.9, confidence: 0.8 };

/** A provider that only answers after `ms`, and records whether it was told to stop. */
function slowJudge(ms: number) {
  const seen: { signal?: AbortSignal } = {};
  const judge: Judge = {
    name: "slow",
    ask: (_s, _q, opts) => {
      if (opts?.signal !== undefined) seen.signal = opts.signal;
      return new Promise<JudgeResult>((resolve) => {
        setTimeout(
          () =>
            resolve({
              ok: true,
              answers: { a: YES },
              provider: "slow",
              model: "m",
              cached: false,
              latencyMs: ms,
            }),
          ms,
        );
      });
    },
  };
  return { judge, seen };
}

describe("withTimeout", () => {
  test("a provider slower than the limit becomes a timeout, and is aborted", async () => {
    // Arrange
    const slow = slowJudge(1_000);
    const guarded = withTimeout(slow.judge, { timeoutMs: 50 });
    const started = performance.now();
    // Act
    const result = await guarded.ask(STATE, [q("a")]);
    // Assert
    const elapsed = performance.now() - started;
    expect(result).toMatchObject({ ok: false, error: "timeout" });
    expect(elapsed).toBeGreaterThanOrEqual(45);
    expect(elapsed).toBeLessThan(500);
    expect(slow.seen.signal?.aborted).toBe(true);
  });

  test("a per-call timeout can only tighten the configured one", async () => {
    const guarded = withTimeout(slowJudge(200).judge, { timeoutMs: 10_000 });
    expect(await guarded.ask(STATE, [q("a")], { timeoutMs: 30 })).toMatchObject({
      error: "timeout",
    });
    const loose = withTimeout(slowJudge(1_000).judge, { timeoutMs: 30 });
    expect(await loose.ask(STATE, [q("a")], { timeoutMs: 60_000 })).toMatchObject({
      error: "timeout",
    });
  });

  test("a fast provider passes through", async () => {
    const guarded = withTimeout(slowJudge(1).judge, { timeoutMs: 1_000 });
    expect(await guarded.ask(STATE, [q("a")])).toMatchObject({ ok: true });
  });

  test("a provider that throws or rejects becomes unreachable", async () => {
    const throwing: Judge = {
      name: "boom",
      ask: () => Promise.reject(new Error("socket hang up")),
    };
    const result = await withTimeout(throwing, { timeoutMs: 1_000 }).ask(STATE, [q("a")]);
    expect(result).toMatchObject({ ok: false, error: "unreachable" });
    expect(!result.ok && result.detail).toContain("socket hang up");
  });

  test("the caller's own abort also ends the wait", async () => {
    const guarded = withTimeout(slowJudge(1_000).judge, { timeoutMs: 10_000 });
    const controller = new AbortController();
    const pending = guarded.ask(STATE, [q("a")], { signal: controller.signal });
    controller.abort();
    expect(await pending).toMatchObject({ ok: false, error: "timeout" });
  });
});

describe("withQuestionLimit", () => {
  test("more than 4 questions is invalid and the provider is never called", async () => {
    let called = false;
    const inner: Judge = {
      name: "x",
      ask: async () => {
        called = true;
        return { ok: false, error: "unreachable", detail: "", latencyMs: 0 };
      },
    };
    const limited = withQuestionLimit(inner, 4);
    const result = await limited.ask(STATE, ["a", "b", "c", "d", "e"].map(q));
    expect(result).toMatchObject({ ok: false, error: "invalid" });
    expect(called).toBe(false);
  });

  test("4 questions pass; duplicate names are invalid", async () => {
    const script = { a: YES, b: YES, c: YES, d: YES };
    const limited = withQuestionLimit(createMockJudge(script), 4);
    expect(await limited.ask(STATE, ["a", "b", "c", "d"].map(q))).toMatchObject({ ok: true });
    expect(await limited.ask(STATE, [q("a"), q("a")])).toMatchObject({ error: "invalid" });
  });
});

describe("withValidation", () => {
  test("a provider answer out of range becomes invalid", async () => {
    const liar: Judge = {
      name: "liar",
      ask: async () => ({
        ok: true,
        answers: { a: { kind: "noul", p: 7, confidence: 1 } },
        provider: "liar",
        model: "m",
        cached: false,
        latencyMs: 1,
      }),
    };
    expect(await withValidation(liar).ask(STATE, [q("a")])).toMatchObject({ error: "invalid" });
  });
});

describe("composeJudge", () => {
  test("applies limit, cache and timeout with the spec defaults", async () => {
    // Arrange
    let calls = 0;
    const base = createMockJudge(() => {
      calls += 1;
      return { a: YES };
    });
    const judge = composeJudge(base, DEFAULT_JUDGE_CONFIG, () => 0);
    // Act
    const first = await judge.ask(STATE, [q("a")]);
    const second = await judge.ask(STATE, [q("a")]);
    const tooMany = await judge.ask(STATE, ["a", "b", "c", "d", "e"].map(q));
    // Assert
    expect(first).toMatchObject({ ok: true, cached: false });
    expect(second).toMatchObject({ ok: true, cached: true });
    expect(tooMany).toMatchObject({ ok: false, error: "invalid" });
    expect(calls).toBe(1);
    expect(judge.name).toBe("mock");
  });

  test("a timeout is not cached", async () => {
    const cfg = { ...DEFAULT_JUDGE_CONFIG, timeoutMs: 20 };
    const judge = composeJudge(createMockJudge({ a: YES }, { delayMs: 200 }), cfg, () => 0);
    expect(await judge.ask(STATE, [q("a")])).toMatchObject({ error: "timeout" });
    expect(await judge.ask(STATE, [q("a")])).toMatchObject({ error: "timeout" });
  });
});
