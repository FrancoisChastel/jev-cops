import type { Answer, JudgeConfig } from "@jevdict/core";
import type { Env, FetchLike } from "./shared.ts";

/** Semantic layer off: every request answers `disabled` and the floor stands. */
export interface OffConfig {
  readonly provider: "off";
}

/** Scripted answers by question name, for fixtures and local runs. */
export interface MockConfig {
  readonly provider: "mock";
  readonly answers: Readonly<Record<string, Answer>>;
}

/**
 * TypeSafe Jev: calibrated probabilities, the recommended provider. The key falls back
 * to `TYPESAFE_API_KEY`; base URL and model come from here only.
 */
export interface JevConfig {
  readonly provider: "jev";
  readonly apiKey?: string;
  readonly baseURL?: string;
  readonly model?: string;
  readonly fetch?: FetchLike;
}

/**
 * Which semantic judge the daemon uses (`judge.provider` in config, D-004). Every
 * variant answers the same typed questions behind the core `Judge` interface.
 */
export type ProviderConfig = OffConfig | MockConfig | JevConfig;

/** What the factory reads from its surroundings; both default to the real ones. */
export interface JudgeDeps {
  /** Where API keys come from when the config has none. Default `process.env`. */
  readonly env?: Env;
  /** Clock for the result cache. Default `Date.now`. */
  readonly now?: () => number;
  /** Timeout, question limit and cache bounds. Default core `DEFAULT_JUDGE_CONFIG`. */
  readonly judgeConfig?: JudgeConfig;
}
