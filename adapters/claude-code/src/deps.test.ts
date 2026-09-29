import { describe, expect, test } from "bun:test";
import { DEADLINE_ENV, DEFAULT_DEADLINES, deadlinesFrom, spend } from "./deps.ts";

describe("deadlines", () => {
  test("the defaults: 13 s PreToolUse run, 5 s other events, 2 s per request", () => {
    expect(deadlinesFrom({})).toEqual({ judgeMs: 13_000, eventMs: 5_000, requestMs: 2_000 });
  });

  test("the environment can only lower them, and never under 50 ms", () => {
    expect(deadlinesFrom({ [DEADLINE_ENV]: "400" })).toEqual({
      judgeMs: 400,
      eventMs: 400,
      requestMs: 400,
    });
    expect(deadlinesFrom({ [DEADLINE_ENV]: "60000" })).toEqual(DEFAULT_DEADLINES);
    expect(deadlinesFrom({ [DEADLINE_ENV]: "1" }).judgeMs).toBe(50);
    expect(deadlinesFrom({ [DEADLINE_ENV]: "soon" })).toEqual(DEFAULT_DEADLINES);
    expect(deadlinesFrom({ [DEADLINE_ENV]: "-5" })).toEqual(DEFAULT_DEADLINES);
  });

  test("time already spent shrinks the run-wide deadlines, never below 1 ms", () => {
    expect(spend(DEFAULT_DEADLINES, 1_500)).toEqual({
      judgeMs: 11_500,
      eventMs: 3_500,
      requestMs: 2_000,
    });
    expect(spend(DEFAULT_DEADLINES, 60_000)).toEqual({ judgeMs: 1, eventMs: 1, requestMs: 2_000 });
    expect(spend(DEFAULT_DEADLINES, -3)).toEqual(DEFAULT_DEADLINES);
  });
});
