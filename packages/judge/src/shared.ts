import type { Judge, JudgeErrorKind, JudgeResult } from "@jev-cops/core";

/** A `fetch` the providers can be given, so tests never touch the network. */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/** The environment the factory reads API keys from (the daemon's own, never the agent's). */
export type Env = Readonly<Record<string, string | undefined>>;

/** A failed {@link JudgeResult} timed from `started` (a `performance.now()` reading). */
export function failure(error: JudgeErrorKind, detail: string, started: number): JudgeResult {
  return { ok: false, error, detail, latencyMs: performance.now() - started };
}

/**
 * The API key to use: the explicit config value, else `env[envVar]`; blank counts as
 * missing. Returns null rather than throwing, so the daemon can start without keys.
 */
export function resolveApiKey(
  explicit: string | undefined,
  env: Env,
  envVar: string,
): string | null {
  const candidates = [explicit, Object.hasOwn(env, envVar) ? env[envVar] : undefined];
  const found = candidates.map((v) => v?.trim() ?? "").find((v) => v !== "");
  return found ?? null;
}

/**
 * The judge used when a real provider has no API key: every request answers
 * `disabled` (the floor stands, the daemon runs observe-only). It never throws and
 * never names the key, only the variable that would hold it.
 */
export function missingKeyJudge(name: string, envVar: string): Judge {
  const detail = `${name} API key not configured (set ${envVar})`;
  return {
    name,
    ask: () => Promise.resolve({ ok: false, error: "disabled", detail, latencyMs: 0 }),
  };
}

/** `text` with every occurrence of `secret` replaced, so a key can never reach a log. */
export function redact(text: string, secret: string): string {
  return secret === "" ? text : text.split(secret).join("[redacted]");
}

/**
 * True when `cause` is an abort: an `AbortError`/`TimeoutError`, or any failure after
 * the caller's `signal` fired (the guard's deadline), so a late socket error still
 * reads as the timeout it was.
 */
export function isAbort(cause: unknown, signal?: AbortSignal): boolean {
  if (signal?.aborted === true) return true;
  if (!(cause instanceof Error)) return false;
  return cause.name === "AbortError" || cause.name === "TimeoutError";
}

/** The message of `cause`, or its string form. */
export function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
