import { describe, expect, test } from "bun:test";
import {
  bashPre,
  CTX_HOME,
  CTX_SESSION,
  toolEvent,
} from "../../../../tests/fixtures/context/index.ts";
import { createCaseFile } from "./casefile.ts";
import { DEFAULT_CONTEXT_CONFIG } from "./config.ts";
import { expectedTools, hostAllowed, scopeScore, taskAllowlist } from "./scope.ts";
import type { CaseFile } from "./types.ts";

const CFG = { ...DEFAULT_CONTEXT_CONFIG, home: CTX_HOME };

function caseFile(task: string | null = "Fix the flaky test in auth/"): CaseFile {
  const cf = createCaseFile(CTX_SESSION, { config: { home: CTX_HOME } });
  if (task !== null) cf.setTaskOnce(task);
  return cf;
}

describe("taskAllowlist", () => {
  test("hosts named in the task: URLs and bare hostnames, lower-cased", () => {
    const list = taskAllowlist("Sync types from https://API.example.com/v1 and docs.example.org");
    expect(list.hosts).toEqual(["api.example.com", "docs.example.org"]);
    expect(list.domains).toEqual([]);
  });

  test("a scheme-less host/path word contributes its host", () => {
    expect(taskAllowlist("Vendor github.com/org/lib into third_party").hosts).toEqual([
      "github.com",
    ]);
  });

  test("file names are not hosts, even when the extension is a real TLD", () => {
    const list = taskAllowlist("Fix install.sh, package.json and auth/session.test.ts");
    expect(list.hosts).toEqual([]);
  });

  test("the git remote host comes from repo hints; absence is fine", () => {
    expect(taskAllowlist("Fix it", { lockfiles: [], remoteHost: "GitLab.com" }).hosts).toEqual([
      "gitlab.com",
    ]);
    expect(taskAllowlist("Fix it", { lockfiles: [] })).toEqual({ hosts: [], domains: [] });
    expect(taskAllowlist(null)).toEqual({ hosts: [], domains: [] });
  });

  test("registries for lockfiles present in the repo or named in the task", () => {
    const list = taskAllowlist("Regenerate Cargo.lock", { lockfiles: ["web/package-lock.json"] });
    expect(list.domains).toEqual(["npmjs.org", "crates.io"]);
  });

  test("hostAllowed: exact for task hosts, subdomains for registries", () => {
    const list = { hosts: ["api.example.com"], domains: ["npmjs.org"] };
    expect(hostAllowed("api.example.com", list)).toBe(true);
    expect(hostAllowed("evil.api.example.com", list)).toBe(false);
    expect(hostAllowed("registry.npmjs.org", list)).toBe(true);
    expect(hostAllowed("npmjs.org", list)).toBe(true);
    expect(hostAllowed("npmjs.org.evil.example", list)).toBe(false);
  });
});

describe("expectedTools", () => {
  test("test/fix tasks expect Bash, Edit and Read", () => {
    const tools = expectedTools("Fix the flaky test in auth/");
    expect(tools).not.toBeNull();
    for (const t of ["Bash", "Edit", "Read"]) expect(tools?.has(t)).toBe(true);
  });

  test("docs tasks expect Read, Edit and WebFetch, not Bash", () => {
    const tools = expectedTools("Improve the README");
    for (const t of ["Read", "Edit", "WebFetch"]) expect(tools?.has(t)).toBe(true);
    expect(tools?.has("Bash")).toBe(false);
  });

  test("keywords combine; unknown tasks have no expected set", () => {
    expect(expectedTools("Fix the docs")?.has("Bash")).toBe(true);
    expect(expectedTools("Make it nicer")).toBeNull();
    expect(expectedTools(null)).toBeNull();
  });
});

describe("scopeScore: deterministic layer", () => {
  test("a path inside the repo is on task", async () => {
    const n = await toolEvent("Edit", "fs.write", { file_path: "auth/session.test.ts" });
    expect(scopeScore(n, caseFile(), CFG)).toMatchObject({ value: 1, unsure: false });
  });

  test("a path outside the repo is off task; /tmp is scratch space", async () => {
    expect(scopeScore(await bashPre("rm -rf /home/dev/old"), caseFile(), CFG)).toMatchObject({
      value: 0,
      unsure: false,
    });
    expect(scopeScore(await bashPre("rm -rf /tmp/build"), caseFile(), CFG).value).toBe(1);
  });

  test("without a repo, the cwd is the root", async () => {
    const shape = { git: null, cwd: "/work/scratch" };
    expect(scopeScore(await bashPre("cat notes.md", shape), caseFile(), CFG).value).toBe(1);
    expect(scopeScore(await bashPre("cat /work/repo/a", shape), caseFile(), CFG).value).toBe(0);
  });

  test("hosts: in the task allowlist → 1, not in it → 0", async () => {
    const cf = caseFile("Fix the flaky test using fixtures from https://fixtures.example.com");
    expect(scopeScore(await bashPre("curl https://fixtures.example.com/a"), cf, CFG).value).toBe(1);
    const off = scopeScore(await bashPre("curl https://evil.example/a"), cf, CFG);
    expect(off).toMatchObject({ value: 0, unsure: false });
    expect(off.why.join(" ")).toContain("evil.example");
  });

  test("a host with no allowlist at all is 0.5 and unsure", async () => {
    const score = scopeScore(await bashPre("curl https://docs.example"), caseFile(), CFG);
    expect(score).toMatchObject({ value: 0.5, unsure: true });
  });

  test("repo hints feed the allowlist (registries, remote)", async () => {
    const hints = { lockfiles: ["package-lock.json"], remoteHost: "github.com" };
    const cf = caseFile();
    const npm = await bashPre("curl https://registry.npmjs.org/left-pad");
    expect(scopeScore(npm, cf, CFG, hints).value).toBe(1);
    const clone = await bashPre("git clone git@github.com:org/repo.git");
    expect(scopeScore(clone, cf, CFG, hints).value).toBe(1);
  });

  test("an exec with no paths or hosts is 0.7 and unsure", async () => {
    expect(scopeScore(await bashPre("npm test"), caseFile(), CFG)).toMatchObject({
      value: 0.7,
      unsure: true,
    });
  });

  test("a read with no path targets the cwd", async () => {
    expect(scopeScore(await bashPre("ls -la"), caseFile(), CFG)).toMatchObject({
      value: 1,
      unsure: false,
    });
  });

  test("opaque constructs cap scope at 0.7 and make it unsure", async () => {
    const score = scopeScore(await bashPre('cat ./a.txt; eval "$CMD"'), caseFile(), CFG);
    expect(score).toMatchObject({ value: 0.7, unsure: true });
  });

  test("a tool outside the task's expected set is 0.5 and unsure", async () => {
    const score = scopeScore(await bashPre("cat README.md"), caseFile("Improve the README"), CFG);
    expect(score).toMatchObject({ value: 0.5, unsure: true });
  });

  test("Pi tool names count as their canonical tool in the expected set", async () => {
    const n = await toolEvent("bash", "exec", { command: "cat README.md" });
    expect(scopeScore(n, caseFile(), CFG)).toMatchObject({ value: 1 });
    const docs = scopeScore(n, caseFile("Improve the README"), CFG);
    expect(docs).toMatchObject({ value: 0.5, unsure: true });
  });

  test("combines as the min over targets; a sure 0 is not unsure", async () => {
    const n = await bashPre("cp src/a.ts /etc/cron.d/a; eval x");
    expect(scopeScore(n, caseFile(), CFG)).toMatchObject({ value: 0, unsure: false });
  });
});
