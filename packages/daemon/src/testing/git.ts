import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

/**
 * Real git repositories for tests. The test itself runs git here (trusted setup, not the
 * daemon's hardened probe), with the user's and the system's config ignored so a
 * developer's `~/.gitconfig` never changes a result.
 */

const TEST_ENV = {
  PATH: process.env.PATH ?? "/usr/bin:/bin",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_TERMINAL_PROMPT: "0",
  LC_ALL: "C",
};
const IDENTITY = ["-c", "user.name=jev-cops-tests", "-c", "user.email=tests@jev-cops.invalid"];

/** Runs `git <args>` in `cwd` for test setup; throws with stderr on failure. */
export function git(cwd: string, ...args: string[]): string {
  const res = Bun.spawnSync(["git", ...IDENTITY, ...args], { cwd, env: TEST_ENV });
  if (res.exitCode !== 0) {
    throw new Error(`git ${args.join(" ")}: ${res.stderr.toString().trim()}`);
  }
  return res.stdout.toString();
}

/** What a test repo starts with. */
export interface RepoOptions {
  /** Branch checked out after the first commit; default `main`. */
  branch?: string;
  /** `remote.origin.url`; none by default. */
  origin?: string;
  /** Branch `refs/remotes/origin/HEAD` points at (as after a clone); none by default. */
  originHead?: string;
  /** Files of the first commit, by repo-relative path; default one README. */
  files?: Readonly<Record<string, string>>;
}

/** Writes `files` under `root`, creating directories. */
export function writeFiles(root: string, files: Readonly<Record<string, string>>): void {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
}

/** A new repo in a fresh temp directory (its real path) with one commit. */
export function makeRepo(opts: RepoOptions = {}): string {
  const repo = realpathSync(mkdtempSync(join(tmpdir(), "jvgit-")));
  git(repo, "init", "-q", "-b", "main");
  writeFiles(repo, opts.files ?? { "README.md": "# test\n" });
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "init");
  if (opts.branch !== undefined && opts.branch !== "main") {
    git(repo, "checkout", "-q", "-b", opts.branch);
  }
  if (opts.origin !== undefined) git(repo, "remote", "add", "origin", opts.origin);
  if (opts.originHead !== undefined) {
    git(repo, "update-ref", `refs/remotes/origin/${opts.originHead}`, "HEAD");
    const target = `refs/remotes/origin/${opts.originHead}`;
    git(repo, "symbolic-ref", "refs/remotes/origin/HEAD", target);
  }
  return repo;
}
