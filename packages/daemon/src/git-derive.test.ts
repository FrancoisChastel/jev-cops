/**
 * The daemon derives `env.git` from the event's cwd, which the agent controls (D-058).
 * A hostile repository must never run code in the daemon, and every failure leaves
 * `env.git` absent (D-024 then treats repo and branch as unknown, i.e. exposed).
 */
import { afterAll, describe, expect, test } from "bun:test";
import {
  appendFileSync,
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deriveGit } from "./git-derive.ts";
import { bunGitRunner, findGit, type GitRunner } from "./git-run.ts";
import { git, makeRepo, writeFiles } from "./testing/git.ts";

const GIT = findGit();
if (GIT === null) throw new Error("these tests need git on PATH");
const RUN = bunGitRunner(GIT);
/** Generous in tests (slow CI); the daemon's default budget is 300 ms. */
const BUDGET = 5_000;

const made: string[] = [];
function repo(opts: Parameters<typeof makeRepo>[0] = {}): string {
  const dir = makeRepo(opts);
  made.push(dir);
  return dir;
}
function scratch(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "jvscr-")));
  made.push(dir);
  return dir;
}
afterAll(() => {
  for (const dir of made) rmSync(dir, { recursive: true, force: true });
});

async function derived(cwd: string, run: GitRunner = RUN, ms = BUDGET) {
  const r = await deriveGit(cwd, run, ms);
  if (!r.ok) throw new Error(`not derived: ${r.error}`);
  return r.value;
}

/**
 * A repo whose config, hooks and attributes run `touch <canaries>/<name>` from every hook
 * point git has for the commands a naive probe would use, with a worktree that makes git
 * read file contents (a modified file, and an index as new as a tracked file).
 */
function hostileRepo(canaries: string): string {
  const touch = (name: string) => `touch '${join(canaries, name)}'`;
  const dir = repo({ files: { "a.txt": "a\n", "sub/b.md": "b\n" }, origin: "https://x.example/r" });
  const evilHooks = join(canaries, "hooks");
  mkdirSync(evilHooks, { recursive: true });
  for (const hooks of [join(dir, ".git", "hooks"), evilHooks]) {
    for (const hook of ["post-checkout", "post-index-change", "reference-transaction"]) {
      writeFileSync(join(hooks, hook), `#!/bin/sh\n${touch(`hook-${hook}`)}\n`);
      chmodSync(join(hooks, hook), 0o755);
    }
  }
  const config = [
    ["core", `fsmonitor = "${touch("fsmonitor")}; true"`, `pager = "${touch("pager")}; cat"`],
    ["core", `sshCommand = "${touch("ssh")}"`, `editor = "${touch("editor")}"`],
    ["core", `askPass = "${touch("askpass")}"`, `hooksPath = ${evilHooks}`],
    ['filter "evil"', `clean = "${touch("filter-clean")}; cat"`, `smudge = "${touch("smudge")}"`],
    ['filter "evil2"', `process = "${touch("filter-process")}"`],
    ['diff "evil"', `textconv = "${touch("textconv")}; cat"`],
    ["diff", `external = "${touch("diff-external")}"`],
    ["gpg", `program = "${touch("gpg")}"`],
  ];
  const text = config.map(([section, ...keys]) => `[${section}]\n\t${keys.join("\n\t")}\n`);
  appendFileSync(join(dir, ".git", "config"), text.join(""));
  writeFiles(dir, { ".git/info/attributes": "*.txt filter=evil diff=evil\n*.md filter=evil2\n" });
  writeFileSync(join(dir, "a.txt"), "changed\n");
  const future = new Date(Date.now() + 5_000);
  utimesSync(join(dir, "sub", "b.md"), future, future);
  utimesSync(join(dir, ".git", "index"), future, future);
  return dir;
}

const fired = (canaries: string) => readdirSync(canaries).filter((f) => f !== "hooks");

describe("a hostile repository never runs code in the daemon", () => {
  test("negative control: `git status` runs its code, even with fsmonitor and hooks off", () => {
    const status = (flags: string[]) => {
      const canaries = scratch();
      const dir = hostileRepo(canaries);
      const env = {
        PATH: process.env.PATH ?? "",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_TERMINAL_PROMPT: "0",
      };
      const args = ["git", ...flags, "status", "--porcelain", "--untracked-files=no"];
      Bun.spawnSync(args, { cwd: dir, env });
      return fired(canaries);
    };
    expect(status([])).toContain("fsmonitor");
    const hardened = status(["-c", "core.fsmonitor=", "-c", "core.hooksPath=/dev/null"]);
    expect(hardened).not.toContain("fsmonitor");
    expect(hardened.some((name) => name.startsWith("filter-"))).toBe(true);
  });

  test("the derivation reads repo, branch and dirty, and no canary appears", async () => {
    const canaries = scratch();
    const dir = hostileRepo(canaries);
    const d = await derived(join(dir, "sub"));
    expect(d.git).toEqual({ repo: dir, branch: "main", dirty: true });
    expect(d.remoteHost).toBe("x.example");
    expect(fired(canaries)).toEqual([]);
  });
});

describe("a partial clone's lazy fetch never reaches a transport", () => {
  test("a missing object with an ext:: promisor remote runs nothing", async () => {
    const canaries = scratch();
    const dir = repo();
    const canary = join(canaries, "ext");
    for (const [key, value] of [
      ["core.repositoryformatversion", "1"],
      ["extensions.partialclone", "origin"],
      ["remote.origin.promisor", "true"],
      ["remote.origin.url", `ext::sh -c touch% ${canary}`],
      ["protocol.ext.allow", "always"],
    ]) {
      git(dir, "config", key as string, value as string);
    }
    const tree = git(dir, "rev-parse", "HEAD^{tree}").trim();
    rmSync(join(dir, ".git", "objects", tree.slice(0, 2), tree.slice(2)));
    const control = Bun.spawnSync(["git", "diff-index", "--cached", "--quiet", "HEAD"], {
      cwd: dir,
      env: { PATH: process.env.PATH ?? "", GIT_CONFIG_NOSYSTEM: "1", HOME: canaries },
    });
    expect(control.exitCode).not.toBe(0);
    expect(readdirSync(canaries)).toEqual(["ext"]);
    rmSync(canary);
    const d = await derived(dir);
    expect(d.git.repo).toBe(dir);
    expect(readdirSync(canaries)).toEqual([]);
  });
});

describe("what is derived", () => {
  test("branch, default branch from origin/HEAD, clean tree, https remote host", async () => {
    const dir = repo({
      branch: "feat/x",
      origin: "https://GitHub.com/o/r.git",
      originHead: "trunk",
    });
    const d = await derived(dir);
    expect(d).toEqual({
      git: { repo: dir, branch: "feat/x", default_branch: "trunk", dirty: false },
      remoteHost: "github.com",
    });
  });

  test("scp-style remote; no origin/HEAD leaves the default branch to D-024", async () => {
    const d = await derived(repo({ origin: "git@gitlab.example:o/r.git" }));
    expect(d.git).not.toHaveProperty("default_branch");
    expect(d.remoteHost).toBe("gitlab.example");
    expect((await derived(repo())).remoteHost).toBeNull();
  });

  test("detached HEAD: no branch", async () => {
    const dir = repo();
    git(dir, "checkout", "-q", "--detach");
    const d = await derived(dir);
    expect(d.git).toEqual({ repo: dir, dirty: false });
  });

  test.each([
    ["an untracked file only", (d: string) => writeFiles(d, { "new.txt": "n" }), false],
    ["an unstaged change", (d: string) => writeFiles(d, { "README.md": "edited" }), true],
    [
      "a staged change",
      (d: string) => {
        writeFiles(d, { "new.txt": "n" });
        git(d, "add", "new.txt");
      },
      true,
    ],
    ["a deleted file", (d: string) => rmSync(join(d, "README.md")), true],
  ])("dirty with %s: %p", async (_name, change, dirty) => {
    const dir = repo();
    change(dir);
    expect((await derived(dir)).git.dirty).toBe(dirty);
  });

  test("from a subdirectory, and through a symlink, the repo is in the cwd's namespace", async () => {
    const dir = repo({ files: { "sub/deep/f.txt": "f" } });
    expect((await derived(join(dir, "sub", "deep"))).git.repo).toBe(dir);
    const link = join(scratch(), "link");
    symlinkSync(dir, link);
    expect((await derived(join(link, "sub"))).git.repo).toBe(link);
  });
});

describe("failures leave env.git absent", () => {
  test("not a repo, a missing, relative or file cwd", async () => {
    let calls = 0;
    const counting: GitRunner = (args, cwd, signal) => {
      calls += 1;
      return RUN(args, cwd, signal);
    };
    const dir = scratch();
    expect(await deriveGit(dir, counting, BUDGET)).toMatchObject({ ok: false });
    expect(calls).toBe(1);
    const file = join(dir, "f");
    writeFileSync(file, "");
    for (const cwd of [join(dir, "missing"), "relative/dir", file, ""]) {
      expect(await deriveGit(cwd, counting, BUDGET)).toEqual({
        ok: false,
        error: "cwd is not a directory",
      });
    }
    expect(calls).toBe(1);
  });

  test("a core.worktree pointing outside the repo is refused", async () => {
    const dir = repo();
    git(dir, "config", "core.worktree", "/");
    expect(await deriveGit(dir, RUN, BUDGET)).toMatchObject({ ok: false });
  });

  test("a git that never answers: absent within the budget, and it is killed", async () => {
    const signals: AbortSignal[] = [];
    const hangs: GitRunner = (_args, _cwd, signal) => {
      signals.push(signal);
      return new Promise(() => undefined);
    };
    const started = performance.now();
    expect(await deriveGit(scratch(), hangs, 50)).toEqual({ ok: false, error: "timeout" });
    expect(performance.now() - started).toBeLessThan(500);
    expect(signals.every((s) => s.aborted)).toBe(true);
  });

  test("a slow second step still fails the whole derivation at the budget", async () => {
    const dir = repo();
    const slowStatus: GitRunner = async (args, cwd, signal) =>
      args[0] === "ls-files" ? new Promise(() => undefined) : RUN(args, cwd, signal);
    expect(await deriveGit(dir, slowStatus, 200)).toEqual({ ok: false, error: "timeout" });
  });

  test("truncated or failed listings leave dirty unknown, never guessed clean", async () => {
    const dir = repo();
    const truncating: GitRunner = async (args, cwd, signal) => {
      const out = await RUN(args, cwd, signal);
      return args[0] === "ls-files" ? { ...out, truncated: true } : out;
    };
    expect((await derived(dir, truncating)).git).not.toHaveProperty("dirty");
    expect(statSync(dir).isDirectory()).toBe(true);
  });
});
