import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Event, RepoHints } from "@jev-cops/core";

const TTL_MS = 60_000;

/** `https://host/…`, `ssh://git@host/…`, `git@host:owner/repo` → `host`. */
export function remoteHost(url: string): string | null {
  const scp = /^[\w.-]+@([\w.-]+):/.exec(url);
  if (scp?.[1] !== undefined) return scp[1].toLowerCase();
  try {
    const host = new URL(url).hostname;
    return host === "" ? null : host.toLowerCase();
  } catch {
    return null;
  }
}

/** The `url` of `[remote "origin"]` (else the first remote) in a git config file. */
export function originUrl(gitConfig: string): string | null {
  let section = "";
  let first: string | null = null;
  for (const raw of gitConfig.split("\n")) {
    const line = raw.trim();
    const header = /^\[(.+)\]$/.exec(line);
    if (header?.[1] !== undefined) section = header[1];
    const url = /^url\s*=\s*(.+)$/.exec(line)?.[1]?.trim();
    if (url === undefined || !section.startsWith("remote ")) continue;
    if (section === 'remote "origin"') return url;
    first ??= url;
  }
  return first;
}

function readHints(repo: string, lockfiles: ReadonlySet<string>): RepoHints {
  let names: string[] = [];
  try {
    names = readdirSync(repo).filter((f) => lockfiles.has(f));
  } catch {
    names = [];
  }
  let url: string | null = null;
  try {
    url = originUrl(readFileSync(join(repo, ".git", "config"), "utf8"));
  } catch {
    url = null;
  }
  const host = url === null ? null : remoteHost(url);
  return { lockfiles: names.sort(), ...(host === null ? {} : { remoteHost: host }) };
}

/**
 * Repo facts the scope feature needs and the event cannot carry (core `RepoHints`):
 * lockfiles at the repo root and the origin remote's host, read by the daemon from
 * `env.git.repo`, cached per repo for a minute. Missing repo → no hints. A host from
 * `git remote get-url origin` (the `env.git` derivation) wins over the config parse.
 */
export class RepoHintsCache {
  private readonly cache = new Map<string, { hints: RepoHints; at: number }>();

  constructor(
    private readonly lockfiles: ReadonlySet<string>,
    private readonly now: () => number = Date.now,
  ) {}

  for(event: Event, remoteHost: string | null = null): RepoHints | null {
    const repo = event.env?.git?.repo;
    if (repo === undefined || repo === "") return null;
    const hit = this.cache.get(repo);
    const fresh = hit !== undefined && this.now() - hit.at < TTL_MS;
    const hints = fresh ? hit.hints : readHints(repo, this.lockfiles);
    if (!fresh) this.cache.set(repo, { hints, at: this.now() });
    return remoteHost === null ? hints : { ...hints, remoteHost };
  }
}
