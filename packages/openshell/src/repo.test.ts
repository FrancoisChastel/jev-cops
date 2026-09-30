import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gitConfigPath, originUrl, parseRemoteUrl, readRepo } from "./repo.ts";

const root = mkdtempSync(join(tmpdir(), "jev-cops-repo-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("parseRemoteUrl", () => {
  test("https, ssh URL, scp-like; ports", () => {
    expect(parseRemoteUrl("https://github.com/o/r.git")).toEqual({
      host: "github.com",
      transport: "https",
      port: 443,
    });
    expect(parseRemoteUrl("https://git.corp.example:8443/o/r")?.port).toBe(8443);
    expect(parseRemoteUrl("git@GitHub.com:o/r.git")).toEqual({
      host: "github.com",
      transport: "ssh",
      port: 22,
    });
    expect(parseRemoteUrl("ssh://git@gitlab.com:2222/o/r.git")).toEqual({
      host: "gitlab.com",
      transport: "ssh",
      port: 2222,
    });
  });

  test("transports with no rule", () => {
    for (const url of ["http://x.example/r", "git://x.example/r", "file:///srv/r", "../r", ""]) {
      expect(parseRemoteUrl(url)).toBeNull();
    }
  });
});

describe("originUrl", () => {
  test("origin first, else the first remote", () => {
    const cfg =
      '[remote "up"]\n\turl = https://a.example/r\n[remote "origin"]\n\turl = git@b.example:r\n';
    expect(originUrl(cfg)).toBe("git@b.example:r");
    expect(originUrl('[remote "up"]\n\turl = https://a.example/r\n')).toBe("https://a.example/r");
    expect(originUrl("[core]\n\tbare = false\n")).toBeNull();
  });
});

describe("readRepo", () => {
  test("a checkout: lockfiles at the root, the origin remote", () => {
    const repo = join(root, "checkout");
    mkdirSync(join(repo, ".git"), { recursive: true });
    writeFileSync(
      join(repo, ".git", "config"),
      '[remote "origin"]\n\turl = https://github.com/o/r\n',
    );
    writeFileSync(join(repo, "package-lock.json"), "{}");
    writeFileSync(join(repo, "poetry.lock"), "");
    writeFileSync(join(repo, "notes.md"), "");
    expect(readRepo(repo)).toEqual({
      lockfiles: ["package-lock.json", "poetry.lock"],
      remote: { host: "github.com", transport: "https", port: 443 },
    });
  });

  test("a worktree: the .git file leads to the common config", () => {
    const main = join(root, "main");
    const wt = join(root, "wt");
    mkdirSync(join(main, ".git", "worktrees", "wt"), { recursive: true });
    mkdirSync(wt, { recursive: true });
    writeFileSync(join(main, ".git", "config"), '[remote "origin"]\n\turl = git@gitlab.com:o/r\n');
    writeFileSync(join(main, ".git", "worktrees", "wt", "commondir"), "../..\n");
    writeFileSync(join(wt, ".git"), `gitdir: ${join(main, ".git", "worktrees", "wt")}\n`);
    expect(gitConfigPath(wt)).toBe(join(main, ".git", "config"));
    expect(readRepo(wt).remote?.host).toBe("gitlab.com");
  });

  test("no repo, no .git, a .git file without gitdir", () => {
    expect(readRepo(join(root, "missing"))).toEqual({ lockfiles: [], remote: null });
    const bare = join(root, "bare");
    mkdirSync(bare);
    expect(readRepo(bare).remote).toBeNull();
    writeFileSync(join(bare, ".git"), "nonsense\n");
    expect(gitConfigPath(bare)).toBeNull();
  });
});
