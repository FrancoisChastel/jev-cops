import { describe, expect, test } from "bun:test";
import { err, ok, type Result } from "./result.ts";

describe("Result", () => {
  test("ok wraps a value in a success branch", () => {
    // Act
    const result: Result<number, string> = ok(42);

    // Assert
    expect(result).toEqual({ ok: true, value: 42 });
  });

  test("err wraps an error in a failure branch", () => {
    // Act
    const result: Result<number, string> = err("boom");

    // Assert
    expect(result).toEqual({ ok: false, error: "boom" });
  });
});
