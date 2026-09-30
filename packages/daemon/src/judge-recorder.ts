import { AsyncLocalStorage } from "node:async_hooks";
import type { Answer, Judge } from "@jev-cops/core";

interface Slot {
  answers: Readonly<Record<string, Answer>> | null;
}

/**
 * Captures the judge's full typed answers for the request being judged, so the audit
 * line can carry them and `cops replay` can feed them back through the mock judge.
 * Scoped with `AsyncLocalStorage`: concurrent requests never see each other's answers.
 */
export class JudgeRecorder {
  private readonly store = new AsyncLocalStorage<Slot>();

  /** `judge` with every successful answer recorded into the current request's slot. */
  wrap(judge: Judge): Judge {
    return {
      name: judge.name,
      ask: async (state, questions, opts) => {
        const result = await judge.ask(state, questions, opts);
        const slot = this.store.getStore();
        if (slot !== undefined && result.ok) slot.answers = structuredClone(result.answers);
        return result;
      },
    };
  }

  /** Runs `fn` with a fresh slot; returns its value and the answers it recorded. */
  async run<T>(
    fn: () => Promise<T>,
  ): Promise<{ value: T; answers: Readonly<Record<string, Answer>> | null }> {
    const slot: Slot = { answers: null };
    const value = await this.store.run(slot, fn);
    return { value, answers: slot.answers };
  }
}
