/**
 * @jevdict/judge — real semantic-judge providers behind the core `Judge` interface
 * (D-004). `createJudge` picks one from config; every real provider is wrapped with the
 * core guards (question limit → cache → validation → timeout), so the floor, routing,
 * timeout and cache rules are identical whichever model answers.
 */
import {
  composeJudge,
  createDisabledJudge,
  createMockJudge,
  DEFAULT_JUDGE_CONFIG,
  type Judge,
} from "@jevdict/core";
import { createJevJudge, JEV_API_KEY_ENV } from "./providers/jev.ts";
import { createOpenRouterJudge, OPENROUTER_API_KEY_ENV } from "./providers/openrouter.ts";
import { createVercelAiJudge } from "./providers/vercel-ai.ts";
import { type Env, missingKeyJudge, resolveApiKey } from "./shared.ts";
import type { JudgeDeps, ProviderConfig } from "./types.ts";

export { JEV_API_KEY_ENV, JEV_DEFAULT_BASE_URL, JEV_DEFAULT_MODEL } from "./providers/jev.ts";
export {
  OPENROUTER_API_KEY_ENV,
  OPENROUTER_DEFAULT_BASE_URL,
  OPENROUTER_DEFAULT_REFERER,
  OPENROUTER_DEFAULT_TITLE,
} from "./providers/openrouter.ts";
export type { VercelAiModel } from "./providers/vercel-ai.ts";
export type { Env, FetchLike } from "./shared.ts";
export type * from "./types.ts";

type RealConfig = Exclude<ProviderConfig, { provider: "off" | "mock" }>;

/** A provider ready to be guarded, or the `disabled` judge standing in for a missing key. */
type Built = { ready: true; judge: Judge } | { ready: false; judge: Judge };

function processEnv(): Env {
  return typeof process === "undefined" ? {} : process.env;
}

function withKey(
  name: string,
  explicit: string | undefined,
  env: Env,
  envVar: string,
  make: (apiKey: string) => Judge,
): Built {
  const apiKey = resolveApiKey(explicit, env, envVar);
  if (apiKey === null) return { ready: false, judge: missingKeyJudge(name, envVar) };
  return { ready: true, judge: make(apiKey) };
}

function buildProvider(config: RealConfig, env: Env): Built {
  switch (config.provider) {
    case "jev":
      return withKey("jev", config.apiKey, env, JEV_API_KEY_ENV, (apiKey) =>
        createJevJudge({ ...config, apiKey }),
      );
    case "openrouter":
      return withKey("openrouter", config.apiKey, env, OPENROUTER_API_KEY_ENV, (apiKey) =>
        createOpenRouterJudge({ ...config, apiKey }),
      );
    case "vercel-ai":
      return { ready: true, judge: createVercelAiJudge({ model: config.model }) };
  }
}

/**
 * The judge for `config`. Real providers are always wrapped with core `composeJudge`
 * (limit → cache → validation → timeout, 10 s by default). Never throws at startup: a
 * real provider without an API key answers every request `disabled`, so the daemon
 * still runs observe-only. Keys come from config, else the daemon's env; never logged.
 */
export function createJudge(config: ProviderConfig, deps: JudgeDeps = {}): Judge {
  switch (config.provider) {
    case "off":
      return createDisabledJudge();
    case "mock":
      return createMockJudge(config.answers);
    default: {
      const built = buildProvider(config, deps.env ?? processEnv());
      if (!built.ready) return built.judge;
      return composeJudge(
        built.judge,
        deps.judgeConfig ?? DEFAULT_JUDGE_CONFIG,
        deps.now ?? Date.now,
      );
    }
  }
}
