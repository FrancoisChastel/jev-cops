import { describe, expect, test } from "bun:test";
import { ANSWER_SCHEMA_NAME, buildAnswerSchema, SYSTEM_PROMPT } from "../prompt.ts";
import { fakeFetch, hang, json, type Responder } from "../testing/fetch.ts";
import { CHOICE, NOUL, QUESTIONS, SCORE, STATE } from "../testing/fixtures.ts";
import {
  createOpenRouterJudge,
  OPENROUTER_DEFAULT_BASE_URL,
  OPENROUTER_DEFAULT_REFERER,
  OPENROUTER_DEFAULT_TITLE,
} from "./openrouter.ts";

const KEY = "sk-or-secret-456";
const MODEL = "openai/gpt-5-mini";

const ANSWERS = {
  [NOUL.name]: { p: 0.9, confidence: 0.95 },
  [CHOICE.name]: {
    choice: "exfil",
    confidence: 0.9,
    probabilities: { task: 0.1, explore: 0.2, exfil: 0.7 },
  },
  [SCORE.name]: { score: 1.6, confidence: 0.85, probabilities: { "0": 0.1, "1": 0.2, "2": 0.7 } },
};

function completion(content: unknown, model = "openai/gpt-5-mini-2026") {
  return json({
    id: "gen-1",
    model,
    choices: [{ index: 0, message: { role: "assistant", content } }],
  });
}

function judgeWith(respond: Responder, extra: { referer?: string; title?: string } = {}) {
  const fake = fakeFetch(respond);
  const judge = createOpenRouterJudge({ apiKey: KEY, model: MODEL, fetch: fake.fetch, ...extra });
  return { judge, sent: fake.sent };
}

describe("openrouter: request", () => {
  test("posts a strict json_schema chat completion with the pinned system text", async () => {
    // Arrange
    const { judge, sent } = judgeWith(async () => completion(JSON.stringify(ANSWERS)));
    // Act
    await judge.ask(STATE, QUESTIONS);
    // Assert
    const [request] = sent;
    expect(request?.url).toBe(`${OPENROUTER_DEFAULT_BASE_URL}/chat/completions`);
    expect(request?.method).toBe("POST");
    const body = JSON.parse(request?.text ?? "{}");
    expect(body).toMatchObject({
      model: MODEL,
      temperature: 0,
      response_format: {
        type: "json_schema",
        json_schema: {
          name: ANSWER_SCHEMA_NAME,
          strict: true,
          schema: buildAnswerSchema(QUESTIONS),
        },
      },
      provider: { require_parameters: true },
    });
    expect(body.messages).toHaveLength(2);
    expect(body.messages[0]).toEqual({ role: "system", content: SYSTEM_PROMPT });
    expect(body.messages[1].role).toBe("user");
    expect(body.messages[1].content).toContain(JSON.stringify(STATE, null, 2));
  });

  test("sends the key as a bearer token and the attribution headers", async () => {
    const plain = judgeWith(async () => completion(JSON.stringify(ANSWERS)));
    await plain.judge.ask(STATE, QUESTIONS);
    const headers = plain.sent[0]?.headers;
    expect(headers?.get("authorization")).toBe(`Bearer ${KEY}`);
    expect(headers?.get("content-type")).toBe("application/json");
    expect(headers?.get("http-referer")).toBe(OPENROUTER_DEFAULT_REFERER);
    expect(headers?.get("x-title")).toBe(OPENROUTER_DEFAULT_TITLE);

    const custom = judgeWith(async () => completion(JSON.stringify(ANSWERS)), {
      referer: "https://example.org",
      title: "team-x",
    });
    await custom.judge.ask(STATE, QUESTIONS);
    expect(custom.sent[0]?.headers.get("http-referer")).toBe("https://example.org");
    expect(custom.sent[0]?.headers.get("x-title")).toBe("team-x");
  });
});

describe("openrouter: answers", () => {
  test("parses the message content into core answers", async () => {
    const { judge } = judgeWith(async () => completion(JSON.stringify(ANSWERS)));
    const result = await judge.ask(STATE, QUESTIONS);
    expect(result).toMatchObject({
      ok: true,
      provider: "openrouter",
      model: "openai/gpt-5-mini-2026",
    });
    if (!result.ok) return;
    expect(result.answers[NOUL.name]).toEqual({
      kind: "noul",
      p: 0.9,
      confidence: 0.95,
    });
    expect(result.answers[CHOICE.name]).toMatchObject({ choice: "exfil", p: 0.7 });
    expect(result.answers[SCORE.name]).toMatchObject({ level: "high" });
  });

  test("falls back to the configured model name", async () => {
    const { judge } = judgeWith(async () =>
      json({ choices: [{ message: { content: JSON.stringify(ANSWERS) } }] }),
    );
    expect(await judge.ask(STATE, QUESTIONS)).toMatchObject({ ok: true, model: MODEL });
  });

  test("content that is not JSON, a missing message or a non-JSON body is invalid", async () => {
    const replies: Responder[] = [
      async () => completion("Sure! The answer is yes."),
      async () => completion(null),
      async () => json({ choices: [] }),
      async () => new Response("<html>bad gateway</html>", { status: 200 }),
    ];
    for (const reply of replies) {
      const { judge } = judgeWith(reply);
      expect(await judge.ask(STATE, QUESTIONS)).toMatchObject({ ok: false, error: "invalid" });
    }
  });
});

describe("openrouter: errors", () => {
  test("HTTP 401/403 are invalid with a clear detail that never echoes the key", async () => {
    for (const status of [401, 403]) {
      const { judge } = judgeWith(async () =>
        json({ error: { message: `bad key ${KEY}` } }, status),
      );
      const result = await judge.ask(STATE, QUESTIONS);
      expect(result).toMatchObject({ ok: false, error: "invalid" });
      expect(!result.ok && result.detail).toBe(`openrouter rejected the API key (HTTP ${status})`);
    }
  });

  test("HTTP 408, 429 and 5xx are unreachable", async () => {
    for (const status of [408, 429, 500, 503]) {
      const { judge } = judgeWith(async () => json({}, status));
      expect(await judge.ask(STATE, QUESTIONS)).toMatchObject({ ok: false, error: "unreachable" });
    }
  });

  test("other 4xx are invalid with the status", async () => {
    const { judge } = judgeWith(async () => json({}, 400));
    const result = await judge.ask(STATE, QUESTIONS);
    expect(result).toMatchObject({ ok: false, error: "invalid" });
    expect(!result.ok && result.detail).toContain("400");
  });

  test("a connection failure is unreachable, with the key redacted", async () => {
    const { judge } = judgeWith(async () => {
      throw new TypeError(`connect failed for Bearer ${KEY}`);
    });
    const result = await judge.ask(STATE, QUESTIONS);
    expect(result).toMatchObject({ ok: false, error: "unreachable" });
    expect(!result.ok && result.detail).not.toContain(KEY);
  });

  test("the caller's abort is a timeout, promptly", async () => {
    const { judge } = judgeWith(hang);
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 20);
    const result = await judge.ask(STATE, QUESTIONS, { signal: controller.signal });
    expect(result).toMatchObject({ ok: false, error: "timeout" });
    expect(result.latencyMs).toBeLessThan(1_000);
  });
});
