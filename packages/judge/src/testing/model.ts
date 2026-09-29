import { MockLanguageModelV4 } from "ai/test";

const USAGE = {
  inputTokens: { total: 100, noCache: 100, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 20, text: 20, reasoning: 0 },
};

/** A fake model that answers every call with `text`, recording each call's options. */
export function textModel(text: string, modelId = "mock-model"): MockLanguageModelV4 {
  return new MockLanguageModelV4({
    modelId,
    doGenerate: async () => ({
      content: [{ type: "text" as const, text }],
      finishReason: { unified: "stop" as const, raw: "stop" },
      usage: USAGE,
      warnings: [],
    }),
  });
}

/** A fake model whose every call throws `error`. */
export function failingModel(error: unknown): MockLanguageModelV4 {
  return new MockLanguageModelV4({
    doGenerate: () => Promise.reject(error),
  });
}

/** A fake model that never answers; rejects with an `AbortError` once the call is aborted. */
export function hangingModel(): MockLanguageModelV4 {
  return new MockLanguageModelV4({
    doGenerate: (options) =>
      new Promise((_, reject) => {
        const abort = () => reject(new DOMException("The operation was aborted.", "AbortError"));
        if (options.abortSignal?.aborted === true) abort();
        options.abortSignal?.addEventListener("abort", abort, { once: true });
      }),
  });
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part: unknown) =>
      typeof part === "object" && part !== null && "text" in part ? String(part.text) : "",
    )
    .join("");
}

/** The system and user text of the model's `index`-th call, as the provider received them. */
export function promptOf(model: MockLanguageModelV4, index = 0): { system: string; user: string } {
  const messages = model.doGenerateCalls[index]?.prompt ?? [];
  const byRole = (role: string) =>
    messages
      .filter((m) => m.role === role)
      .map((m) => textOf(m.content))
      .join("\n");
  return { system: byRole("system"), user: byRole("user") };
}
