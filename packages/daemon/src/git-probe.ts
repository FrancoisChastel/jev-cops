import type { Event, GitInfo } from "@jev-cops/core";
import { type DerivedGit, deriveGit } from "./git-derive.ts";
import type { GitRunner } from "./git-run.ts";
import { type Logger, SILENT_LOGGER } from "./log.ts";

/** How long a derivation is reused for one cwd (a branch can change; keep it short). */
export const GIT_PROBE_TTL_MS = 5_000;
/** Distinct cwds remembered; the oldest is dropped past this. */
export const GIT_PROBE_MAX_ENTRIES = 256;
/** Default budget for one derivation, all git calls included (`daemon.git_probe_timeout_ms`). */
export const DEFAULT_GIT_PROBE_TIMEOUT_MS = 300;

/** How the daemon derives `env.git`. */
export interface GitProbeOptions {
  /** Null when no git binary was found: nothing is derived. */
  readonly run: GitRunner | null;
  readonly timeoutMs: number;
  readonly now?: () => number;
  readonly log?: Logger;
  readonly ttlMs?: number;
  readonly maxEntries?: number;
}

/** An event with `env.git` completed by the daemon, and what it filled in. */
export interface Probed<E extends Event> {
  readonly event: E;
  /** The `env.git` fields the daemon derived (audit `derived.git`); null when none. */
  readonly derived: GitInfo | null;
  /** The origin's host from the derivation, for `repoHints`; null when not derived. */
  readonly remoteHost: string | null;
}

const KEYS = ["repo", "branch", "default_branch", "dirty"] as const;

/**
 * `event` with `derived` filling the `env.git` keys the adapter did not send; the
 * adapter's own values always win. Returns `event` itself when nothing is derived.
 * `replay` uses it to judge a recorded event as the daemon did.
 */
export function withDerivedGit<E extends Event>(event: E, derived: GitInfo | null | undefined): E {
  if (derived === null || derived === undefined || Object.keys(derived).length === 0) return event;
  const git = { ...derived, ...event.env?.git };
  return { ...event, env: { ...event.env, git } };
}

/** The derived keys `given` lacks. */
function missing(given: GitInfo, derived: GitInfo): GitInfo {
  const entries = KEYS.filter((k) => given[k] === undefined && derived[k] !== undefined).map(
    (k) => [k, derived[k]],
  );
  return Object.fromEntries(entries) as GitInfo;
}

/**
 * Completes `env.git` from the event's cwd when the adapter sent no `repo` or `branch`
 * (Pi sends none, D-058): derived outside the sandbox by {@link deriveGit}, cached per
 * cwd for {@link GIT_PROBE_TTL_MS} (concurrent events share one derivation), failures
 * included. A failure leaves the event as it was (D-024: unknown is exposure) and writes
 * only a debug log line.
 */
export class GitProbe {
  private readonly cache = new Map<string, { at: number; value: Promise<DerivedGit | null> }>();
  private readonly now: () => number;
  private readonly log: Logger;
  private readonly ttlMs: number;
  private readonly maxEntries: number;

  constructor(private readonly opts: GitProbeOptions) {
    this.now = opts.now ?? Date.now;
    this.log = opts.log ?? SILENT_LOGGER;
    this.ttlMs = opts.ttlMs ?? GIT_PROBE_TTL_MS;
    this.maxEntries = opts.maxEntries ?? GIT_PROBE_MAX_ENTRIES;
  }

  /** `event` with its missing `env.git` keys derived, or unchanged. */
  async apply<E extends Event>(event: E): Promise<Probed<E>> {
    const given = event.env?.git ?? {};
    const none = { event, derived: null, remoteHost: null };
    if (given.repo !== undefined && given.branch !== undefined) return none;
    const found = await this.lookup(event.call.cwd);
    if (found === null) return none;
    const filled = missing(given, found.git);
    const sameRepo = given.repo === undefined || given.repo === found.git.repo;
    const remoteHost = sameRepo ? found.remoteHost : null;
    if (Object.keys(filled).length === 0) return { ...none, remoteHost };
    return { event: withDerivedGit(event, filled), derived: filled, remoteHost };
  }

  private lookup(cwd: string): Promise<DerivedGit | null> {
    const hit = this.cache.get(cwd);
    if (hit !== undefined && this.now() - hit.at < this.ttlMs) return hit.value;
    const value = this.derive(cwd);
    this.cache.delete(cwd);
    this.cache.set(cwd, { at: this.now(), value });
    for (const key of this.cache.keys()) {
      if (this.cache.size <= this.maxEntries) break;
      this.cache.delete(key);
    }
    return value;
  }

  private async derive(cwd: string): Promise<DerivedGit | null> {
    if (this.opts.run === null) return null;
    const result = await deriveGit(cwd, this.opts.run, this.opts.timeoutMs);
    if (result.ok) return result.value;
    this.log.log("debug", "env.git not derived", { cwd, why: result.error });
    return null;
  }
}
