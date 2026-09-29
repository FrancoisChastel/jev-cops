import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildEvent } from "../../../tests/fixtures/context/index.ts";
import { originUrl, RepoHintsCache, remoteHost } from "./repo-hints.ts";

describe("remote parsing", () => {
  test.each([
    ["https://github.com/o/r.git", "github.com"],
    ["git@GitLab.example:o/r.git", "gitlab.example"],
    ["ssh://git@git.example:2222/o/r", "git.example"],
    ["not a url", null],
  ])("%s → %s", (url, host) => {
    expect(remoteHost(url)).toBe(host);
  });

  test("origin wins over other remotes", () => {
    const cfg =
      '[remote "fork"]\n\turl = https://a.example/x\n[remote "origin"]\n\turl = https://b.example/y\n';
    expect(originUrl(cfg)).toBe("https://b.example/y");
    expect(originUrl("[core]\n\turl = nope\n")).toBeNull();
  });
});

describe("RepoHintsCache", () => {
  let repo: string;
  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), "jevdict-repo-"));
    mkdirSync(join(repo, ".git"));
    writeFileSync(
      join(repo, ".git", "config"),
      '[remote "origin"]\n\turl = git@github.com:o/r.git\n',
    );
    writeFileSync(join(repo, "bun.lock"), "");
    writeFileSync(join(repo, "README.md"), "");
  });
  afterEach(() => rmSync(repo, { recursive: true, force: true }));

  test("reads lockfiles and the origin host from env.git.repo", () => {
    const cache = new RepoHintsCache(new Set(["bun.lock", "go.sum"]));
    const e = buildEvent(
      { tool: "Bash", kind: "exec", input: { command: "ls" } },
      { git: { repo } },
    );
    expect(cache.for(e)).toEqual({ lockfiles: ["bun.lock"], remoteHost: "github.com" });
  });

  test("a host from the env.git derivation wins over the config parse", () => {
    const cache = new RepoHintsCache(new Set(["bun.lock"]));
    const e = buildEvent(
      { tool: "Bash", kind: "exec", input: { command: "ls" } },
      { git: { repo } },
    );
    expect(cache.for(e, "gitlab.example")).toEqual({
      lockfiles: ["bun.lock"],
      remoteHost: "gitlab.example",
    });
    expect(cache.for(e)).toEqual({ lockfiles: ["bun.lock"], remoteHost: "github.com" });
  });

  test("no repo, no hints; an unreadable repo gives empty hints", () => {
    const cache = new RepoHintsCache(new Set(["bun.lock"]));
    const bare = buildEvent(
      { tool: "Bash", kind: "exec", input: { command: "ls" } },
      { git: null },
    );
    expect(cache.for(bare)).toBeNull();
    const gone = buildEvent(
      { tool: "Bash", kind: "exec", input: { command: "ls" } },
      { git: { repo: join(repo, "missing") } },
    );
    expect(cache.for(gone)).toEqual({ lockfiles: [] });
  });
});
