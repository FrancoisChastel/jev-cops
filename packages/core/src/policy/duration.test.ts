import { describe, expect, test } from "bun:test";
import { parseDuration } from "./duration.ts";

describe("parseDuration", () => {
  test.each([
    ["30s", 30_000],
    ["2m", 120_000],
    ["1h", 3_600_000],
    ["1.5m", 90_000],
    ["0s", 0],
  ] as const)("%s → %d ms", (input, ms) => {
    expect(parseDuration(input)).toBe(ms);
  });

  test("a number is milliseconds", () => {
    expect(parseDuration(250)).toBe(250);
  });

  test.each(["", "2", "m", "2 m", "-1m", "2d", "1e3s", "2mm"])("rejects %p", (input) => {
    expect(() => parseDuration(input as "1m")).toThrow(RangeError);
  });

  test("rejects negative, NaN and infinite numbers", () => {
    expect(() => parseDuration(-1)).toThrow(RangeError);
    expect(() => parseDuration(Number.NaN)).toThrow(RangeError);
    expect(() => parseDuration(Number.POSITIVE_INFINITY)).toThrow(RangeError);
  });
});
