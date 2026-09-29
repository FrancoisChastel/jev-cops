import { describe, expect, test } from "bun:test";
import { cacheKey, withCache } from "./cache.ts";
import type { Answer, Judge, JudgeResult, JudgeState, Question } from "./types.ts";

const STATE: JudgeState = {
  stateHash: "b".repeat(64),
  tool: "Bash",
  kind: "exec",
  command: "ls",
  raw: "ls",
  verbs: ["ls"],
  paths: [],
  hosts: [],
  opaque: [],
  features: { taint: 0, scope: 0.7, sequence: 0, environment: 0, reversibility: 0 },
  task: "Fix the flaky test in auth/",
  casefile: { recentCalls: [], secretReads: 0, hostsSeen: [] },
};
const Q: Question = { kind: "noul", name: "fits", text: "fits the task" };
const YES: Answer = { kind: "noul", p: 0.9, confidence: 0.8 };

/** A judge that counts calls and answers `fits: YES`, or fails when told to. */
function countingJudge(outcomes: Array<"ok" | "fail"> = []) {
  let calls = 0;
  const judge: Judge = {
    name: "counting",
    ask: async (): Promise<JudgeResult> => {
      const outcome = outcomes[calls] ?? "ok";
      calls += 1;
      if (outcome === "fail") return { ok: false, error: "unreachable", detail: "x", latencyMs: 1 };
      return {
        ok: true,
        answers: { fits: YES },
        provider: "counting",
        model: "m",
        cached: false,
        latencyMs: 5,
      };
    },
  };
  return { judge, calls: () => calls };
}

function clock(start = 0) {
  let t = start;
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms;
    },
  };
}

describe("withCache", () => {
  test("a miss calls the provider, a hit does not and is marked cached", async () => {
    // Arrange
    const inner = countingJudge();
    const cached = withCache(inner.judge, { now: clock().now });
    // Act
    const first = await cached.ask(STATE, [Q]);
    const second = await cached.ask(STATE, [Q]);
    // Assert
    expect(first).toMatchObject({ ok: true, cached: false });
    expect(second).toMatchObject({ ok: true, cached: true, answers: { fits: YES } });
    expect(inner.calls()).toBe(1);
  });

  test("entries expire after the TTL (10 minutes by default)", async () => {
    const inner = countingJudge();
    const c = clock();
    const cached = withCache(inner.judge, { now: c.now });
    await cached.ask(STATE, [Q]);
    c.advance(10 * 60_000 - 1);
    expect(await cached.ask(STATE, [Q])).toMatchObject({ cached: true });
    c.advance(1);
    expect(await cached.ask(STATE, [Q])).toMatchObject({ cached: false });
    expect(inner.calls()).toBe(2);
  });

  test("errors are never cached", async () => {
    const inner = countingJudge(["fail", "ok"]);
    const cached = withCache(inner.judge, { now: clock().now });
    expect(await cached.ask(STATE, [Q])).toMatchObject({ ok: false });
    expect(await cached.ask(STATE, [Q])).toMatchObject({ ok: true, cached: false });
    expect(inner.calls()).toBe(2);
  });

  test("the key changes with the state hash, the task, and any question text", () => {
    const base = cacheKey(STATE, [Q]);
    expect(cacheKey({ ...STATE, stateHash: "c".repeat(64) }, [Q])).not.toBe(base);
    expect(cacheKey({ ...STATE, task: "Deploy to prod" }, [Q])).not.toBe(base);
    expect(cacheKey(STATE, [{ ...Q, text: "other text" }])).not.toBe(base);
  });

  test("the key ignores question order and non-keyed state", () => {
    const other: Question = { kind: "noul", name: "other", text: "t" };
    expect(cacheKey(STATE, [Q, other])).toBe(cacheKey(STATE, [other, Q]));
    expect(cacheKey({ ...STATE, command: "ls -la" }, [Q])).toBe(cacheKey(STATE, [Q]));
  });

  test("the cache is bounded: the least recently used entry is evicted", async () => {
    const inner = countingJudge();
    const cached = withCache(inner.judge, { now: clock().now, maxEntries: 2 });
    const s = (h: string) => ({ ...STATE, stateHash: h.repeat(64) });
    await cached.ask(s("1"), [Q]);
    await cached.ask(s("2"), [Q]);
    await cached.ask(s("1"), [Q]); // touch 1: 2 is now least recently used
    await cached.ask(s("3"), [Q]); // evicts 2
    expect(await cached.ask(s("1"), [Q])).toMatchObject({ cached: true });
    expect(await cached.ask(s("2"), [Q])).toMatchObject({ cached: false });
    expect(inner.calls()).toBe(4);
  });

  test("a caller mutating a cached result cannot poison the cache", async () => {
    const cached = withCache(countingJudge().judge, { now: clock().now });
    await cached.ask(STATE, [Q]);
    const hit = await cached.ask(STATE, [Q]);
    expect(() => {
      if (hit.ok) (hit.answers.fits as { p: number }).p = 0;
    }).toThrow();
    expect(await cached.ask(STATE, [Q])).toMatchObject({ answers: { fits: YES } });
  });
});
