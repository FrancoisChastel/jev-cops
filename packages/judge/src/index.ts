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
import { type Env, missingKeyJudge, resolveApiKey } from "./shared.ts";
import type { JevConfig, JudgeDeps, ProviderConfig } from "./types.ts";

export { JEV_API_KEY_ENV, JEV_DEFAULT_BASE_URL, JEV_DEFAULT_MODEL } from "./providers/jev.ts";
export type { Env, FetchLike } from "./shared.ts";
export type * from "./types.ts";

function processEnv(): Env {
  return typeof process === "undefined" ? {} : process.env;
}

function jevJudge(config: JevConfig, env: Env): Judge | null {
  const apiKey = resolveApiKey(config.apiKey, env, JEV_API_KEY_ENV);
  if (apiKey === null) return null;
  return createJevJudge({
    apiKey,
    ...(config.baseURL !== undefined ? { baseURL: config.baseURL } : {}),
    ...(config.model !== undefined ? { model: config.model } : {}),
    ...(config.fetch !== undefined ? { fetch: config.fetch } : {}),
  });
}

/** The real provider for `config`, or null when its API key is missing. */
function realProvider(
  config: JevConfig,
  env: Env,
): { base: Judge | null; name: string; envVar: string } {
  return { base: jevJudge(config, env), name: "jev", envVar: JEV_API_KEY_ENV };
}

/**
 * The judge for `config`. Never throws at startup: a real provider without an API key
 * answers every request `disabled`, so the daemon still runs observe-only.
 */
export function createJudge(config: ProviderConfig, deps: JudgeDeps = {}): Judge {
  switch (config.provider) {
    case "off":
      return createDisabledJudge();
    case "mock":
      return createMockJudge(config.answers);
    default: {
      const { base, name, envVar } = realProvider(config, deps.env ?? processEnv());
      if (base === null) return missingKeyJudge(name, envVar);
      return composeJudge(base, deps.judgeConfig ?? DEFAULT_JUDGE_CONFIG, deps.now ?? Date.now);
    }
  }
}
