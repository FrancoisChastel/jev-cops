/**
 * The repo facts the task allowlist needs, read from the host copy of the repository by
 * `cops openshell` (D-109: the baseline is compiled at creation from "the host copy of the
 * repo's lockfiles"): lockfile names at the root and the origin remote with its transport.
 * Files only, never a git process: the checkout is agent-controlled (D-067, D-069).
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { DEFAULT_CONTEXT_CONFIG } from "@jev-cops/core";
import type { GitRemote, RepoInput } from "./fragments/task-allowlist.ts";

const SSH_PORT = 22;
const HTTPS_PORT = 443;

/**
 * `https://host[:port]/…` → https; `ssh://[user@]host[:port]/…` and scp-like
 * `user@host:path` → ssh; anything else (http, git://, file, a local path) → null: no rule.
 */
export function parseRemoteUrl(url: string): GitRemote | null {
  const scp = /^[\w.-]+@([\w.-]+):(?!\/\/)/.exec(url.trim());
  if (scp?.[1] !== undefined)
    return { host: scp[1].toLowerCase(), transport: "ssh", port: SSH_PORT };
  let parsed: URL;
  try {
    parsed = new URL(url.trim());
  } catch {
    return null;
  }
  const host = parsed.hostname.toLowerCase();
  if (host === "") return null;
  const port = parsed.port === "" ? null : Number(parsed.port);
  if (parsed.protocol === "https:") return { host, transport: "https", port: port ?? HTTPS_PORT };
  if (parsed.protocol === "ssh:") return { host, transport: "ssh", port: port ?? SSH_PORT };
  return null;
}

/** The `url` of `[remote "origin"]`, else of the first remote, in a git config file. */
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

/** `.git/config`, or the common config of a worktree (`.git` file → gitdir → commondir). */
export function gitConfigPath(repo: string): string | null {
  const dotGit = join(repo, ".git");
  if (!existsSync(dotGit)) return null;
  if (statSync(dotGit).isDirectory()) return join(dotGit, "config");
  const gitdir = /^gitdir:\s*(.+)$/m.exec(readFileSync(dotGit, "utf8"))?.[1]?.trim();
  if (gitdir === undefined) return null;
  const dir = resolve(repo, gitdir);
  const common = join(dir, "commondir");
  const base = existsSync(common) ? resolve(dir, readFileSync(common, "utf8").trim()) : dir;
  return join(base, "config");
}

function readRemote(repo: string): GitRemote | null {
  try {
    const path = gitConfigPath(repo);
    const url = path === null ? null : originUrl(readFileSync(path, "utf8"));
    return url === null ? null : parseRemoteUrl(url);
  } catch {
    return null;
  }
}

/** Lockfiles at `repo`'s root (the registry table's names) and its origin remote. */
export function readRepo(
  repo: string,
  lockfileNames: readonly string[] = Object.keys(DEFAULT_CONTEXT_CONFIG.scope.registries),
): RepoInput {
  let names: string[];
  try {
    names = readdirSync(repo).filter((f) => lockfileNames.includes(f));
  } catch {
    names = [];
  }
  return { lockfiles: names.sort(), remote: readRemote(repo) };
}
