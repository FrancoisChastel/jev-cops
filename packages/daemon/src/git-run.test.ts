import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { absolutePath, bunGitRunner, findGit, GIT_GUARD_ARGS, gitEnv } from "./git-run.ts";

const dir = realpathSync(mkdtempSync(join(tmpdir(), "jvrun-")));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const live = () => new AbortController().signal;

describe("environment and flags", () => {
  test("relative PATH entries are dropped (git must never resolve in the agent's cwd)", () => {
    expect(absolutePath(".:/usr/bin::bin:/bin")).toBe("/usr/bin:/bin");
  });

  test("nothing is inherited; config, transports and lazy fetch are off", () => {
    const env = gitEnv("/usr/bin:.");
    expect(env).toMatchObject({
      PATH: "/usr/bin",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_ALLOW_PROTOCOL: "",
      GIT_NO_LAZY_FETCH: "1",
      GIT_OPTIONAL_LOCKS: "0",
      GIT_TERMINAL_PROMPT: "0",
    });
    expect(Object.keys(env).some((k) => ["HOME", "GIT_DIR", "GIT_SSH_COMMAND"].includes(k))).toBe(
      false,
    );
    expect(GIT_GUARD_ARGS).toEqual([
      "--no-pager",
      "-c",
      "core.fsmonitor=",
      "-c",
      "core.hooksPath=/dev/null",
      "-c",
      "protocol.allow=never",
    ]);
  });

  test("git is found on absolute PATH entries only", () => {
    expect(findGit()).toStartWith("/");
    expect(findGit("relative/bin:.")).toBeNull();
  });
});

describe("bunGitRunner", () => {
  const git = findGit() ?? "git";

  test("runs git and returns its exit code and stdout", async () => {
    const out = await bunGitRunner(git)(["--version"], dir, live());
    expect(out).toMatchObject({ code: 0, truncated: false });
    expect(out.stdout).toStartWith("git version");
  });

  test("output past the bound is cut and marked truncated", async () => {
    const out = await bunGitRunner(git, { maxBytes: 4 })(["--version"], dir, live());
    expect(out).toMatchObject({ stdout: "git ", truncated: true });
  });

  test("an aborted signal runs nothing; a missing binary is a failure, not a throw", async () => {
    const aborted = new AbortController();
    aborted.abort();
    expect(await bunGitRunner(git)(["--version"], dir, aborted.signal)).toEqual({
      code: -1,
      stdout: "",
      truncated: false,
    });
    const missing = await bunGitRunner(join(dir, "no-git"))(["--version"], dir, live());
    expect(missing.code).toBe(-1);
  });

  test.each([
    ["git itself hangs", "exec sleep 3"],
    ["a child of git keeps stdout open", "sleep 3 &\nwait"],
  ])("aborting mid-run returns at once with -1 (%s)", async (_name, body) => {
    const fake = join(dir, `fake-git-${body.length}`);
    writeFileSync(fake, `#!/bin/sh\n${body}\n`);
    chmodSync(fake, 0o755);
    const controller = new AbortController();
    const running = bunGitRunner(fake)(["status"], dir, controller.signal);
    setTimeout(() => controller.abort(), 50);
    const started = performance.now();
    expect((await running).code).toBe(-1);
    expect(performance.now() - started).toBeLessThan(1_000);
  });
});
