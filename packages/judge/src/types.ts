import type { Answer, JudgeConfig } from "@jevdict/core";
import type { VercelAiModel } from "./providers/vercel-ai.ts";
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
 * OpenRouter: any model with structured outputs. Confidence is self-reported, so less
 * calibrated than Jev. The key falls back to `OPENROUTER_API_KEY`.
 */
export interface OpenRouterConfig {
  readonly provider: "openrouter";
  /** A model that supports structured outputs, e.g. `openai/gpt-5-mini`. */
  readonly model: string;
  readonly apiKey?: string;
  readonly baseURL?: string;
  readonly fetch?: FetchLike;
  /** `HTTP-Referer` attribution header; default the project URL. */
  readonly referer?: string;
  /** `X-Title` attribution header; default `jevdict`. */
  readonly title?: string;
}

/**
 * Vercel AI SDK: bring your own `LanguageModel` instance (any AI SDK provider package).
 * No key is read here; the model instance carries its own credentials.
 */
export interface VercelAiConfig {
  readonly provider: "vercel-ai";
  readonly model: VercelAiModel;
}

/**
 * Which semantic judge the daemon uses (`judge.provider` in config, D-004). Every
 * variant answers the same typed questions behind the core `Judge` interface.
 */
export type ProviderConfig = OffConfig | MockConfig | JevConfig | OpenRouterConfig | VercelAiConfig;

/** What the factory reads from its surroundings; both default to the real ones. */
export interface JudgeDeps {
  /** Where API keys come from when the config has none. Default `process.env`. */
  readonly env?: Env;
  /** Clock for the result cache. Default `Date.now`. */
  readonly now?: () => number;
  /** Timeout, question limit and cache bounds. Default core `DEFAULT_JUDGE_CONFIG`. */
  readonly judgeConfig?: JudgeConfig;
}
