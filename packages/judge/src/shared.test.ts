import { describe, expect, test } from "bun:test";
import { isAbort, missingKeyJudge, redact, resolveApiKey } from "./shared.ts";
import { QUESTIONS, STATE } from "./testing/fixtures.ts";

describe("resolveApiKey", () => {
  test("an explicit key wins over the environment", () => {
    // Arrange
    const env = { TYPESAFE_API_KEY: "from-env" };
    // Act
    const key = resolveApiKey("explicit", env, "TYPESAFE_API_KEY");
    // Assert
    expect(key).toBe("explicit");
  });

  test("falls back to the environment variable", () => {
    expect(resolveApiKey(undefined, { OPENROUTER_API_KEY: "k" }, "OPENROUTER_API_KEY")).toBe("k");
  });

  test("blank or missing keys resolve to null", () => {
    expect(resolveApiKey(undefined, {}, "TYPESAFE_API_KEY")).toBeNull();
    expect(resolveApiKey("  ", { TYPESAFE_API_KEY: "\t" }, "TYPESAFE_API_KEY")).toBeNull();
  });

  test("surrounding whitespace is trimmed", () => {
    expect(resolveApiKey(undefined, { K: "  abc \n" }, "K")).toBe("abc");
  });
});

describe("missingKeyJudge", () => {
  test("answers disabled with the provider and variable named, never throws", async () => {
    // Arrange
    const judge = missingKeyJudge("jev", "TYPESAFE_API_KEY");
    // Act
    const result = await judge.ask(STATE, QUESTIONS);
    // Assert
    expect(judge.name).toBe("jev");
    expect(result).toEqual({
      ok: false,
      error: "disabled",
      detail: "jev API key not configured (set TYPESAFE_API_KEY)",
      latencyMs: 0,
    });
  });
});

describe("redact", () => {
  test("replaces every occurrence of the secret", () => {
    expect(redact("bad key sk-123 and sk-123", "sk-123")).toBe("bad key [redacted] and [redacted]");
  });

  test("an empty secret leaves the text alone", () => {
    expect(redact("text", "")).toBe("text");
  });
});

describe("isAbort", () => {
  test("an AbortError or TimeoutError is an abort", () => {
    expect(isAbort(new DOMException("x", "AbortError"))).toBe(true);
    expect(isAbort(new DOMException("x", "TimeoutError"))).toBe(true);
  });

  test("any error counts once the caller's signal has aborted", () => {
    const controller = new AbortController();
    controller.abort();
    expect(isAbort(new Error("socket closed"), controller.signal)).toBe(true);
  });

  test("an ordinary error with a live signal is not an abort", () => {
    expect(isAbort(new Error("boom"), new AbortController().signal)).toBe(false);
    expect(isAbort("boom")).toBe(false);
  });
});
