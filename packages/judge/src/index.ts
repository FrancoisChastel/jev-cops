/**
 * @jevdict/judge — real semantic-judge providers behind the core `Judge` interface
 * (D-004). `createJudge` picks one from config; every real provider is wrapped with the
 * core guards (question limit → cache → validation → timeout), so the floor, routing,
 * timeout and cache rules are identical whichever model answers.
 */
import { createDisabledJudge, createMockJudge, type Judge } from "@jevdict/core";
import type { JudgeDeps, ProviderConfig } from "./types.ts";

export type { Env, FetchLike } from "./shared.ts";
export type * from "./types.ts";

/**
 * The judge for `config`. Never throws at startup: a real provider without an API key
 * answers every request `disabled`, so the daemon still runs observe-only.
 */
export function createJudge(config: ProviderConfig, _deps: JudgeDeps = {}): Judge {
  switch (config.provider) {
    case "off":
      return createDisabledJudge();
    case "mock":
      return createMockJudge(config.answers);
  }
}
