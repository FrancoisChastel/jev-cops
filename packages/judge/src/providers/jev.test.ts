import { describe, expect, test } from "bun:test";
import { fakeFetch, hang, json, type Responder } from "../testing/fetch.ts";
import { CHOICE, NOUL, QUESTIONS, SCORE, STATE } from "../testing/fixtures.ts";
import { createJevJudge, JEV_DEFAULT_BASE_URL, JEV_DEFAULT_MODEL } from "./jev.ts";

const KEY = "ts-secret-key-123";

/** A well-formed `/v1/systemone` body for the fixture questions. */
const JEV_BODY = {
  model: "jev-2026-09",
  answers: {
    [NOUL.name]: { type: "noul", noul: 0.9 },
    [CHOICE.name]: {
      type: "choice",
      choice: "exfil",
      confidence: 0.9,
      probabilities: { task: 0.1, explore: 0.2, exfil: 0.7 },
    },
    [SCORE.name]: {
      type: "score",
      score: 1.6,
      confidence: 0.85,
      legend: { "0": "none", "1": "low", "2": "high" },
      probabilities: { "0": 0.1, "1": 0.2, "2": 0.7 },
    },
  },
  usage: { input_tokens: 10, output_tokens: 3 },
};

function judgeWith(respond: Responder) {
  const fake = fakeFetch(respond);
  return { judge: createJevJudge({ apiKey: KEY, fetch: fake.fetch }), sent: fake.sent };
}

describe("jev: request", () => {
  test("posts the state as-is and the mapped questions to /v1/systemone", async () => {
    // Arrange
    const { judge, sent } = judgeWith(async () => json(JEV_BODY));
    // Act
    await judge.ask(STATE, QUESTIONS);
    // Assert
    expect(sent).toHaveLength(1);
    const [request] = sent;
    expect(request?.url).toBe(`${JEV_DEFAULT_BASE_URL}/v1/systemone`);
    expect(request?.method).toBe("POST");
    expect(request?.headers.get("authorization")).toBe(`Bearer ${KEY}`);
    const body = JSON.parse(request?.text ?? "{}");
    expect(body.model).toBe(JEV_DEFAULT_MODEL);
    expect(body.state).toEqual(JSON.parse(JSON.stringify(STATE)));
    expect(body.questions).toEqual({
      [NOUL.name]: {
        type: "noul",
        instructions: NOUL.text,
        criteria: { true: "a secret leaves the machine", false: "nothing sensitive leaves" },
      },
      [CHOICE.name]: {
        type: "choice",
        instructions: CHOICE.text,
        criteria: { task: "needed for the task", explore: null, exfil: "moves data out" },
      },
      [SCORE.name]: { type: "score", instructions: SCORE.text, criteria: ["none", "low", "high"] },
    });
  });

  test("a noul question without criteria sends none", async () => {
    const { judge, sent } = judgeWith(async () =>
      json({ model: "m", answers: { bare: { type: "noul", noul: 0.2 } } }),
    );
    await judge.ask(STATE, [{ kind: "noul", name: "bare", text: "Is it bare?" }]);
    expect(JSON.parse(sent[0]?.text ?? "{}").questions.bare).toEqual({
      type: "noul",
      instructions: "Is it bare?",
    });
  });

  test("the configured base URL and model are used, never TYPESAFE_BASE_URL from the environment", async () => {
    const previous = process.env.TYPESAFE_BASE_URL;
    process.env.TYPESAFE_BASE_URL = "https://attacker.example";
    try {
      const fake = fakeFetch(async () => json(JEV_BODY));
      const judge = createJevJudge({ apiKey: KEY, fetch: fake.fetch, model: "jev-pinned" });
      await judge.ask(STATE, QUESTIONS);
      expect(fake.sent[0]?.url).toStartWith(JEV_DEFAULT_BASE_URL);
      expect(JSON.parse(fake.sent[0]?.text ?? "{}").model).toBe("jev-pinned");
    } finally {
      if (previous === undefined) delete process.env.TYPESAFE_BASE_URL;
      else process.env.TYPESAFE_BASE_URL = previous;
    }
  });
});

describe("jev: answers", () => {
  test("maps SDK answers to core answers; noul confidence is 1 (D-038)", async () => {
    const { judge } = judgeWith(async () => json(JEV_BODY));
    const result = await judge.ask(STATE, QUESTIONS);
    expect(result).toMatchObject({
      ok: true,
      provider: "jev",
      model: "jev-2026-09",
      cached: false,
    });
    if (!result.ok) return;
    expect(result.answers[NOUL.name]).toEqual({
      kind: "noul",
      p: 0.9,
      confidence: 1,
    });
    expect(result.answers[CHOICE.name]).toMatchObject({ choice: "exfil", p: 0.7, confidence: 0.9 });
    expect(result.answers[SCORE.name]).toMatchObject({
      score: 1.6,
      level: "high",
      confidence: 0.85,
    });
  });

  test("an answer of the wrong type is invalid", async () => {
    const body = {
      ...JEV_BODY,
      answers: { ...JEV_BODY.answers, [NOUL.name]: { type: "score", score: 1 } },
    };
    const { judge } = judgeWith(async () => json(body));
    const result = await judge.ask(STATE, QUESTIONS);
    expect(result).toMatchObject({ ok: false, error: "invalid" });
    expect(!result.ok && result.detail).toContain("expected a noul answer");
  });

  test("a body that is not JSON is invalid", async () => {
    const { judge } = judgeWith(async () => new Response("<html>oops</html>", { status: 200 }));
    expect(await judge.ask(STATE, QUESTIONS)).toMatchObject({ ok: false, error: "invalid" });
  });
});

describe("jev: errors", () => {
  test("HTTP 500 is unreachable and is not retried", async () => {
    const { judge, sent } = judgeWith(async () => json({ error: "boom" }, 500));
    expect(await judge.ask(STATE, QUESTIONS)).toMatchObject({ ok: false, error: "unreachable" });
    expect(sent).toHaveLength(1);
  });

  test("HTTP 429 and 408 are unreachable", async () => {
    for (const status of [408, 429]) {
      const { judge } = judgeWith(async () => json({}, status));
      expect(await judge.ask(STATE, QUESTIONS)).toMatchObject({ ok: false, error: "unreachable" });
    }
  });

  test("HTTP 401 is invalid with a clear detail that never echoes the key", async () => {
    const { judge } = judgeWith(async () => json({ error: `bad key ${KEY}` }, 401));
    const result = await judge.ask(STATE, QUESTIONS);
    expect(result).toMatchObject({ ok: false, error: "invalid" });
    expect(!result.ok && result.detail).toContain("401");
    expect(!result.ok && result.detail).not.toContain(KEY);
  });

  test("other 4xx are invalid with the status", async () => {
    const { judge } = judgeWith(async () => json({}, 422));
    const result = await judge.ask(STATE, QUESTIONS);
    expect(result).toMatchObject({ ok: false, error: "invalid" });
    expect(!result.ok && result.detail).toContain("422");
  });

  test("a connection failure is unreachable", async () => {
    const { judge } = judgeWith(async () => {
      throw new TypeError("fetch failed: ECONNREFUSED");
    });
    expect(await judge.ask(STATE, QUESTIONS)).toMatchObject({ ok: false, error: "unreachable" });
  });

  test("the caller's abort is a timeout, promptly", async () => {
    const { judge } = judgeWith(hang);
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 20);
    const result = await judge.ask(STATE, QUESTIONS, { signal: controller.signal });
    expect(result).toMatchObject({ ok: false, error: "timeout" });
    expect(result.latencyMs).toBeLessThan(1_000);
  });

  test("the per-call deadline is passed to the SDK and ends as a timeout", async () => {
    const { judge } = judgeWith(hang);
    const result = await judge.ask(STATE, QUESTIONS, { timeoutMs: 30 });
    expect(result).toMatchObject({ ok: false, error: "timeout" });
    expect(result.latencyMs).toBeLessThan(1_000);
  });
});
