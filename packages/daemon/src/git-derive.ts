import { existsSync, statSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { err, type GitInfo, ok, type Result } from "@jev-cops/core";
import { worktreeDirty } from "./git-dirty.ts";
import type { GitOutput, GitRunner } from "./git-run.ts";
import { remoteHost } from "./repo-hints.ts";

/**
 * `env.git` derived by the daemon from an event's cwd when the adapter sends none (D-058),
 * outside the sandbox. The cwd is agent-controlled, so only read-only commands run, each
 * through the hardened {@link GitRunner}, under one hard deadline for the whole
 * derivation; any failure means "not derived" and D-024 treats repo and branch as
 * unknown.
 */

/** What the daemon derived: `env.git` fields and the origin host for `repoHints`. */
export interface DerivedGit {
  /** Always `repo`; `branch` unless HEAD is detached; `default_branch` from origin/HEAD. */
  readonly git: GitInfo;
  readonly remoteHost: string | null;
}

/** Why a derivation produced nothing (a debug log line, never an audit line). */
export type DeriveFailure =
  | "cwd is not a directory"
  | "not a git work tree"
  | "repo root has no .git"
  | "timeout";

type Git = (args: readonly string[], cwd: string) => Promise<GitOutput>;

function isDirectory(path: string): boolean {
  try {
    return isAbsolute(path) && statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function isUnder(path: string, root: string): boolean {
  return path === root || path.startsWith(root === "/" ? "/" : `${root}/`);
}

/** The single line of a successful call, else null. */
function oneLine(out: GitOutput): string | null {
  if (out.code !== 0 || out.truncated || !out.stdout.endsWith("\n")) return null;
  const line = out.stdout.slice(0, -1);
  return line === "" || line.includes("\n") ? null : line;
}

/**
 * The repo root in the cwd's own namespace: `cwd` minus the prefix git reports, so a
 * cwd reached through a symlink (macOS `/tmp`, `/var`) keeps its spelling and scope,
 * environment and taint compare like with like; else git's (real) top level.
 */
export function repoRoot(cwd: string, toplevel: string, prefix: string): string {
  const here = resolve(cwd);
  const rel = prefix.replace(/\/$/, "");
  if (rel === "") return here;
  return here.endsWith(`/${rel}`) ? here.slice(0, -(rel.length + 1)) || "/" : toplevel;
}

/** Repo root and index path from `rev-parse`, checked: the root holds `.git` and the cwd. */
async function locate(
  git: Git,
  cwd: string,
): Promise<Result<{ repo: string; index: string }, DeriveFailure>> {
  const out = await git(
    ["rev-parse", "--show-toplevel", "--show-prefix", "--git-path", "index"],
    cwd,
  );
  const lines = out.code === 0 && !out.truncated ? out.stdout.split("\n") : [];
  const [toplevel = "", prefix = "", index = "", end] = lines;
  if (lines.length !== 4 || end !== "" || !isAbsolute(toplevel) || index === "") {
    return err("not a git work tree");
  }
  const repo = repoRoot(cwd, toplevel, prefix);
  if (!existsSync(join(repo, ".git")) || !isUnder(resolve(cwd), repo)) {
    return err("repo root has no .git");
  }
  return ok({ repo, index: resolve(cwd, index) });
}

/** Staged changes (index vs HEAD) or changed tracked files; null when neither is known. */
async function dirtyState(git: Git, repo: string, index: string, deadline: number) {
  const [staged, listing] = await Promise.all([
    git(["diff-index", "--cached", "--quiet", "HEAD", "--"], repo),
    git(["ls-files", "-s", "--debug", "-z"], repo),
  ]);
  const cached = staged.code === 0 ? false : staged.code === 1 ? true : null;
  const worktree =
    listing.code === 0 && !listing.truncated
      ? worktreeDirty(listing.stdout, repo, index, deadline)
      : null;
  if (cached === true || worktree === true) return true;
  return cached === false && worktree === false ? false : null;
}

async function probe(
  git: Git,
  cwd: string,
  deadline: number,
): Promise<Result<DerivedGit, DeriveFailure>> {
  const where = await locate(git, cwd);
  if (!where.ok) return where;
  const { repo, index } = where.value;
  const [head, origin, url, dirty] = await Promise.all([
    git(["symbolic-ref", "--short", "-q", "HEAD"], repo),
    git(["symbolic-ref", "--short", "-q", "refs/remotes/origin/HEAD"], repo),
    git(["remote", "get-url", "origin"], repo),
    dirtyState(git, repo, index, deadline),
  ]);
  const branch = oneLine(head);
  const originHead = oneLine(origin);
  const defaultBranch = originHead?.startsWith("origin/") ? originHead.slice(7) : "";
  const remote = oneLine(url);
  return ok({
    git: {
      repo,
      ...(branch === null ? {} : { branch }),
      ...(defaultBranch === "" ? {} : { default_branch: defaultBranch }),
      ...(dirty === null ? {} : { dirty }),
    },
    remoteHost: remote === null ? null : remoteHost(remote),
  });
}

/**
 * Derives `env.git` for `cwd` (absolute, an existing directory) with `run`, all of it
 * within `timeoutMs`: past the deadline every git process is killed and the result is
 * `timeout`, whatever the runner does.
 */
export async function deriveGit(
  cwd: string,
  run: GitRunner,
  timeoutMs: number,
): Promise<Result<DerivedGit, DeriveFailure>> {
  if (!isDirectory(cwd)) return err("cwd is not a directory");
  const controller = new AbortController();
  const deadline = performance.now() + timeoutMs;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<Result<DerivedGit, DeriveFailure>>((done) => {
    timer = setTimeout(() => {
      controller.abort();
      done(err("timeout"));
    }, timeoutMs);
  });
  const git: Git = (args, dir) => run(args, dir, controller.signal);
  const work = probe(git, cwd, deadline).catch(() => err("not a git work tree" as const));
  const outcome = await Promise.race([work, late]);
  clearTimeout(timer);
  return controller.signal.aborted ? err("timeout") : outcome;
}
