import { describe, expect, test } from "bun:test";
import { DEFAULT_JUDGE_CONFIG, type Question } from "@jevdict/core";
import { createJudge } from "./index.ts";
import { fakeFetch, json } from "./testing/fetch.ts";
import { MOCK_ANSWERS, NOUL, QUESTIONS, STATE } from "./testing/fixtures.ts";
import { textModel } from "./testing/model.ts";

const jevNoul = () =>
  json({ model: "jev-x", answers: { [NOUL.name]: { type: "noul", noul: 0.9 } } });

describe("createJudge: jev", () => {
  test("without a key it answers disabled and never calls out", async () => {
    // Arrange
    const fake = fakeFetch(async () => jevNoul());
    // Act
    const judge = createJudge({ provider: "jev", fetch: fake.fetch }, { env: {} });
    const result = await judge.ask(STATE, [NOUL]);
    // Assert
    expect(result).toMatchObject({ ok: false, error: "disabled" });
    expect(!result.ok && result.detail).toBe("jev API key not configured (set TYPESAFE_API_KEY)");
    expect(fake.sent).toHaveLength(0);
  });

  test("reads TYPESAFE_API_KEY from the injected env; an explicit key wins", async () => {
    const fromEnv = fakeFetch(async () => jevNoul());
    await createJudge(
      { provider: "jev", fetch: fromEnv.fetch },
      { env: { TYPESAFE_API_KEY: "env-key" } },
    ).ask(STATE, [NOUL]);
    const explicit = fakeFetch(async () => jevNoul());
    await createJudge(
      { provider: "jev", apiKey: "cfg-key", fetch: explicit.fetch },
      { env: { TYPESAFE_API_KEY: "env-key" } },
    ).ask(STATE, [NOUL]);
    expect(fromEnv.sent[0]?.headers.get("authorization")).toBe("Bearer env-key");
    expect(explicit.sent[0]?.headers.get("authorization")).toBe("Bearer cfg-key");
  });

  test("is wrapped with the core guards: question limit and cache", async () => {
    // Arrange
    const fake = fakeFetch(async () => jevNoul());
    const judge = createJudge({ provider: "jev", apiKey: "k", fetch: fake.fetch });
    const five: Question[] = [1, 2, 3, 4, 5].map((i) => ({ ...NOUL, name: `q${i}` }));
    // Act
    const tooMany = await judge.ask(STATE, five);
    const first = await judge.ask(STATE, [NOUL]);
    const second = await judge.ask(STATE, [NOUL]);
    // Assert
    expect(tooMany).toMatchObject({ ok: false, error: "invalid" });
    expect(first).toMatchObject({ ok: true, cached: false, provider: "jev" });
    expect(second).toMatchObject({ ok: true, cached: true });
    expect(fake.sent).toHaveLength(1);
  });

  test("the configured timeout bounds the provider", async () => {
    const fake = fakeFetch(
      (_r, signal) =>
        new Promise((_, reject) => {
          signal?.addEventListener("abort", () => reject(new DOMException("x", "AbortError")));
        }),
    );
    const judge = createJudge(
      { provider: "jev", apiKey: "k", fetch: fake.fetch },
      { judgeConfig: { ...DEFAULT_JUDGE_CONFIG, timeoutMs: 30 } },
    );
    const result = await judge.ask(STATE, [NOUL]);
    expect(result).toMatchObject({ ok: false, error: "timeout" });
    expect(result.latencyMs).toBeLessThan(1_000);
  });
});

describe("createJudge: openrouter", () => {
  const reply = () =>
    json({
      choices: [
        { message: { content: JSON.stringify({ [NOUL.name]: { p: 0.1, confidence: 0.9 } }) } },
      ],
    });

  test("without a key it answers disabled and never calls out", async () => {
    const fake = fakeFetch(async () => reply());
    const judge = createJudge(
      { provider: "openrouter", model: "m", fetch: fake.fetch },
      { env: {} },
    );
    const result = await judge.ask(STATE, [NOUL]);
    expect(result).toMatchObject({
      ok: false,
      error: "disabled",
      detail: "openrouter API key not configured (set OPENROUTER_API_KEY)",
    });
    expect(fake.sent).toHaveLength(0);
  });

  test("reads OPENROUTER_API_KEY and is wrapped with the cache", async () => {
    const fake = fakeFetch(async () => reply());
    const judge = createJudge(
      { provider: "openrouter", model: "m", fetch: fake.fetch },
      { env: { OPENROUTER_API_KEY: "or-key" } },
    );
    await judge.ask(STATE, [NOUL]);
    const second = await judge.ask(STATE, [NOUL]);
    expect(fake.sent[0]?.headers.get("authorization")).toBe("Bearer or-key");
    expect(second).toMatchObject({ ok: true, cached: true, provider: "openrouter" });
    expect(fake.sent).toHaveLength(1);
  });
});

describe("createJudge: vercel-ai", () => {
  test("needs no key and is wrapped with the cache", async () => {
    // Arrange
    const model = textModel(JSON.stringify({ [NOUL.name]: { p: 0.2, confidence: 0.7 } }), "byo");
    const judge = createJudge({ provider: "vercel-ai", model }, { env: {} });
    // Act
    const first = await judge.ask(STATE, [NOUL]);
    const second = await judge.ask(STATE, [NOUL]);
    // Assert
    expect(first).toMatchObject({ ok: true, provider: "vercel-ai", model: "byo", cached: false });
    expect(second).toMatchObject({ ok: true, cached: true });
    expect(model.doGenerateCalls).toHaveLength(1);
  });
});

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
