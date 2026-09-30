import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Event } from "@jev-cops/core";
import { buildEvent } from "../../../tests/fixtures/context/index.ts";
import { GitProbe, withDerivedGit } from "./git-probe.ts";
import { bunGitRunner, findGit, type GitRunner } from "./git-run.ts";
import type { Logger } from "./log.ts";
import { makeRepo } from "./testing/git.ts";

const RUN = bunGitRunner(findGit() ?? "git");
const repo = makeRepo({ origin: "https://github.com/o/r.git", originHead: "main" });
const plain = realpathSync(mkdtempSync(join(tmpdir(), "jvplain-")));
afterAll(() => {
  rmSync(repo, { recursive: true, force: true });
  rmSync(plain, { recursive: true, force: true });
});

function event(cwd: string, git: Record<string, unknown> | null = null): Event {
  return buildEvent({ tool: "Bash", kind: "exec", input: { command: "ls" } }, { cwd, git });
}

/** Counts derivations (one `rev-parse` each) through the real runner. */
function counting(): { run: GitRunner; derivations: () => number } {
  let n = 0;
  const run: GitRunner = (args, cwd, signal) => {
    if (args[0] === "rev-parse") n += 1;
    return RUN(args, cwd, signal);
  };
  return { run, derivations: () => n };
}

function probe(
  run: GitRunner | null,
  extra: Partial<ConstructorParameters<typeof GitProbe>[0]> = {},
) {
  return new GitProbe({ run, timeoutMs: 5_000, ...extra });
}

describe("GitProbe.apply", () => {
  test("an adapter that sends repo and branch is never probed", async () => {
    const c = counting();
    const given = event(repo, { repo: "/work/repo", branch: "feat" });
    const out = await probe(c.run).apply(given);
    expect(out).toEqual({ event: given, derived: null, remoteHost: null });
    expect(c.derivations()).toBe(0);
  });

  test("no env.git: the daemon fills it and reports what it derived", async () => {
    const out = await probe(RUN).apply(event(repo));
    const git = { repo, branch: "main", default_branch: "main", dirty: false };
    expect(out.event.env?.git).toEqual(git);
    expect(out.derived).toEqual(git);
    expect(out.remoteHost).toBe("github.com");
    expect(out.event.env?.sandbox).toEqual({ kind: "openshell", name: "demo" });
  });

  test("a partial env.git: only missing keys are filled, the adapter's values win", async () => {
    const out = await probe(RUN).apply(event(repo, { repo: "/elsewhere", dirty: true }));
    expect(out.event.env?.git).toEqual({
      repo: "/elsewhere",
      dirty: true,
      branch: "main",
      default_branch: "main",
    });
    expect(out.derived).toEqual({ branch: "main", default_branch: "main" });
    expect(out.remoteHost).toBeNull();
  });

  test("not a repo: the event is unchanged and only a debug line says why", async () => {
    const lines: unknown[] = [];
    const log: Logger = { log: (level, msg, fields) => lines.push({ level, msg, ...fields }) };
    const given = event(plain);
    expect(await probe(RUN, { log }).apply(given)).toEqual({
      event: given,
      derived: null,
      remoteHost: null,
    });
    expect(lines).toEqual([
      expect.objectContaining({ level: "debug", cwd: plain, why: "not a git work tree" }),
    ]);
  });

  test("without git on PATH nothing is derived", async () => {
    const given = event(repo);
    expect((await probe(null).apply(given)).event).toBe(given);
  });
});

describe("GitProbe cache", () => {
  test("one derivation per cwd for 5 s, shared by concurrent events", async () => {
    let at = 0;
    const c = counting();
    const p = probe(c.run, { now: () => at });
    await Promise.all([p.apply(event(repo)), p.apply(event(repo)), p.apply(event(repo))]);
    await p.apply(event(repo));
    expect(c.derivations()).toBe(1);
    at += 4_999;
    await p.apply(event(repo));
    expect(c.derivations()).toBe(1);
    at += 1;
    await p.apply(event(repo));
    expect(c.derivations()).toBe(2);
  });

  test("failures are cached too, and the cache is bounded", async () => {
    const c = counting();
    const p = probe(c.run, { maxEntries: 1 });
    await p.apply(event(plain));
    await p.apply(event(plain));
    expect(c.derivations()).toBe(1);
    await p.apply(event(repo));
    await p.apply(event(plain));
    expect(c.derivations()).toBe(3);
  });
});

describe("withDerivedGit", () => {
  test("fills env.git under the adapter's own keys; nothing derived → the same event", () => {
    const given = event(repo, { branch: "feat" });
    expect(withDerivedGit(given, null)).toBe(given);
    const merged = withDerivedGit(given, { repo: "/r", branch: "main" });
    expect(merged.env?.git).toEqual({ repo: "/r", branch: "feat" });
    expect(given.env?.git).toEqual({ branch: "feat" });
  });
});
