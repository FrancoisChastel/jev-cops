import { describe, expect, test } from "bun:test";
import { APICallError } from "ai";
import { z } from "zod";
import { buildAnswerSchema, SYSTEM_PROMPT } from "../prompt.ts";
import { CHOICE, NOUL, QUESTIONS, SCORE, STATE } from "../testing/fixtures.ts";
import { failingModel, hangingModel, promptOf, textModel } from "../testing/model.ts";
import { buildZodAnswerSchema, createVercelAiJudge } from "./vercel-ai.ts";

const ANSWERS = {
  [NOUL.name]: { p: 0.9, confidence: 0.95 },
  [CHOICE.name]: {
    choice: "exfil",
    confidence: 0.9,
    probabilities: { task: 0.1, explore: 0.2, exfil: 0.7 },
  },
  [SCORE.name]: { score: 1.6, confidence: 0.85, probabilities: { "0": 0.1, "1": 0.2, "2": 0.7 } },
};

describe("buildZodAnswerSchema", () => {
  test("describes exactly the JSON Schema the other LLM providers send", () => {
    const { $schema: _draft, ...schema } = z.toJSONSchema(buildZodAnswerSchema(QUESTIONS));
    expect(schema).toEqual(JSON.parse(JSON.stringify(buildAnswerSchema(QUESTIONS))));
  });

  test("rejects a label outside the options", () => {
    const bad = { ...ANSWERS, [CHOICE.name]: { ...ANSWERS[CHOICE.name], choice: "bogus" } };
    expect(buildZodAnswerSchema(QUESTIONS).safeParse(bad).success).toBe(false);
    expect(buildZodAnswerSchema(QUESTIONS).safeParse(ANSWERS).success).toBe(true);
  });
});

describe("vercel-ai: call", () => {
  test("sends the pinned system text, the state as the prompt, temperature 0 and a JSON schema", async () => {
    // Arrange
    const model = textModel(JSON.stringify(ANSWERS));
    // Act
    await createVercelAiJudge({ model }).ask(STATE, QUESTIONS);
    // Assert
    const { system, user } = promptOf(model);
    expect(system).toBe(SYSTEM_PROMPT);
    expect(user).toContain(JSON.stringify(STATE, null, 2));
    const call = model.doGenerateCalls[0];
    expect(call?.temperature).toBe(0);
    expect(call?.responseFormat).toMatchObject({ type: "json" });
  });

  test("maps the structured output to core answers; model is the modelId", async () => {
    const judge = createVercelAiJudge({ model: textModel(JSON.stringify(ANSWERS), "acme-7b") });
    const result = await judge.ask(STATE, QUESTIONS);
    expect(judge.name).toBe("vercel-ai");
    expect(result).toMatchObject({ ok: true, provider: "vercel-ai", model: "acme-7b" });
    if (!result.ok) return;
    expect(result.answers[NOUL.name]).toEqual({
      kind: "noul",
      p: 0.9,
      confidence: 0.95,
    });
    expect(result.answers[CHOICE.name]).toMatchObject({ choice: "exfil", p: 0.7 });
    expect(result.answers[SCORE.name]).toMatchObject({ level: "high" });
  });
});

describe("vercel-ai: errors", () => {
  test("text that is not JSON, or an unknown label, is invalid", async () => {
    const bad = { ...ANSWERS, [CHOICE.name]: { ...ANSWERS[CHOICE.name], choice: "bogus" } };
    for (const text of ["I think yes.", JSON.stringify(bad)]) {
      const result = await createVercelAiJudge({ model: textModel(text) }).ask(STATE, QUESTIONS);
      expect(result).toMatchObject({ ok: false, error: "invalid" });
    }
  });

  test("an HTTP 500 from the model provider is unreachable and not retried", async () => {
    const error = new APICallError({
      message: "Internal Server Error",
      url: "https://llm.example/v1",
      requestBodyValues: {},
      statusCode: 500,
    });
    const model = failingModel(error);
    const result = await createVercelAiJudge({ model }).ask(STATE, QUESTIONS);
    expect(result).toMatchObject({ ok: false, error: "unreachable" });
    expect(model.doGenerateCalls).toHaveLength(1);
  });

  test("any other failure is unreachable", async () => {
    const model = failingModel(new TypeError("fetch failed"));
    const result = await createVercelAiJudge({ model }).ask(STATE, QUESTIONS);
    expect(result).toMatchObject({ ok: false, error: "unreachable" });
  });

  test("the caller's abort is a timeout, promptly", async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 20);
    const judge = createVercelAiJudge({ model: hangingModel() });
    const result = await judge.ask(STATE, QUESTIONS, { signal: controller.signal });
    expect(result).toMatchObject({ ok: false, error: "timeout" });
    expect(result.latencyMs).toBeLessThan(1_000);
  });
});
