import { APICallError } from "ai";
import type { MockLanguageModelV4 } from "ai/test";
import { SYSTEM_PROMPT } from "../prompt.ts";
import { fakeFetch, hang, json, type Responder } from "../testing/fetch.ts";
import { failingModel, hangingModel, promptOf, textModel } from "../testing/model.ts";
import { describeProviderContract, type Reply, type WireAnswer } from "./contract.ts";
import { createJevJudge } from "./jev.ts";
import { createOpenRouterJudge } from "./openrouter.ts";
import { createVercelAiJudge } from "./vercel-ai.ts";

const MALFORMED = "<html><body>502 Bad Gateway</body></html>";

/** How one provider's HTTP wire encodes answers and a malformed reply. */
interface Wire {
  readonly answer: (a: WireAnswer) => unknown;
  readonly body: (answers: Record<string, unknown>) => unknown;
  readonly malformed: () => Response;
}

function llmAnswer(a: WireAnswer): unknown {
  const { kind: _kind, ...rest } = a;
  return rest;
}

const JEV_WIRE: Wire = {
  answer(a) {
    if (a.kind === "noul") return { type: "noul", noul: a.p };
    const { kind, ...rest } = a;
    return kind === "score" ? { type: kind, ...rest, legend: {} } : { type: kind, ...rest };
  },
  body: (answers) => ({ model: "jev-fake", answers, usage: { input_tokens: 1, output_tokens: 1 } }),
  malformed: () => new Response(MALFORMED, { status: 200 }),
};

function completion(content: string): Response {
  return json({ model: "fake/model", choices: [{ message: { content } }] });
}

const OPENROUTER_WIRE: Wire = {
  answer: llmAnswer,
  body: (answers) => ({
    model: "fake/model",
    choices: [{ message: { content: JSON.stringify(answers) } }],
  }),
  malformed: () => completion("Sure! It looks safe to me."),
};

function encode(reply: Extract<Reply, { type: "answers" }>, one: (a: WireAnswer) => unknown) {
  return Object.fromEntries(Object.entries(reply.answers).map(([name, a]) => [name, one(a)]));
}

function responder(reply: Reply, wire: Wire): Responder {
  switch (reply.type) {
    case "answers":
      return async () => json(wire.body(encode(reply, wire.answer)));
    case "status":
      return async () => json({ error: "upstream" }, reply.status);
    case "malformed":
      return async () => wire.malformed();
    case "hang":
      return hang;
  }
}

describeProviderContract({
  name: "jev",
  create(reply) {
    const fake = fakeFetch(responder(reply, JEV_WIRE));
    return {
      judge: createJevJudge({ apiKey: "k", fetch: fake.fetch }),
      exchanges: () =>
        fake.sent.map((r) => ({
          outgoing: r.text,
          fixed: JSON.stringify(JSON.parse(r.text).questions),
        })),
    };
  },
});

describeProviderContract({
  name: "openrouter",
  systemText: SYSTEM_PROMPT,
  create(reply) {
    const fake = fakeFetch(responder(reply, OPENROUTER_WIRE));
    return {
      judge: createOpenRouterJudge({ apiKey: "k", model: "fake/model", fetch: fake.fetch }),
      exchanges: () =>
        fake.sent.map((r) => ({
          outgoing: r.text,
          fixed: String(JSON.parse(r.text).messages[0].content),
        })),
    };
  },
});

function vercelModel(reply: Reply): MockLanguageModelV4 {
  switch (reply.type) {
    case "answers":
      return textModel(JSON.stringify(encode(reply, llmAnswer)));
    case "status":
      return failingModel(
        new APICallError({
          message: `HTTP ${reply.status}`,
          url: "https://llm.example/v1",
          requestBodyValues: {},
          statusCode: reply.status,
        }),
      );
    case "malformed":
      return textModel(MALFORMED);
    case "hang":
      return hangingModel();
  }
}

describeProviderContract({
  name: "vercel-ai",
  systemText: SYSTEM_PROMPT,
  create(reply) {
    const model = vercelModel(reply);
    return {
      judge: createVercelAiJudge({ model }),
      exchanges: () =>
        model.doGenerateCalls.map((_, i) => {
          const { system, user } = promptOf(model, i);
          return { outgoing: `${system}\n${user}`, fixed: system };
        }),
    };
  },
});
