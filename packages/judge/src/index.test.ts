import { describe, expect, test } from "bun:test";
import { createJudge } from "./index.ts";
import { MOCK_ANSWERS, QUESTIONS, STATE } from "./testing/fixtures.ts";

describe("createJudge: off and mock", () => {
  test("off returns the core disabled judge", async () => {
    // Arrange
    const judge = createJudge({ provider: "off" });
    // Act
    const result = await judge.ask(STATE, QUESTIONS);
    // Assert
    expect(result).toMatchObject({ ok: false, error: "disabled" });
  });

  test("mock answers from the scripted answers", async () => {
    const judge = createJudge({ provider: "mock", answers: MOCK_ANSWERS });
    const result = await judge.ask(STATE, QUESTIONS);
    expect(judge.name).toBe("mock");
    expect(result).toMatchObject({ ok: true, answers: MOCK_ANSWERS, provider: "mock" });
  });

  test("mock with a missing scripted answer is invalid, like the core mock", async () => {
    const judge = createJudge({ provider: "mock", answers: {} });
    expect(await judge.ask(STATE, QUESTIONS)).toMatchObject({ ok: false, error: "invalid" });
  });
});
