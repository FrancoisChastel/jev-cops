/**
 * `env.git` derived by the daemon, end to end over the socket: what the engine judged
 * with, and how the audit log records its provenance (`derived.git`) next to the
 * adapter's verbatim event.
 */
import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { buildEvent } from "../../../tests/fixtures/context/index.ts";
import type { AuditLine } from "./audit.ts";
import type { GitRunner } from "./git-run.ts";
import { startTestDaemon, type TestDaemon, withFreshId } from "./testing/daemon.ts";
import { makeRepo } from "./testing/git.ts";
import { policyModule } from "./testing/policies.ts";

const repo = makeRepo({
  files: { "README.md": "# r\n", "sub/a.txt": "a\n" },
  origin: "git@github.com:o/r.git",
  originHead: "main",
});
afterAll(() => rmSync(repo, { recursive: true, force: true }));
const DERIVED = { repo, branch: "main", default_branch: "main", dirty: false };

let td: TestDaemon | null = null;
afterEach(async () => {
  await td?.stop();
  td = null;
});

function event(command: string, cwd: string, git: Record<string, unknown> | null = null) {
  const call = { tool: "Bash", kind: "exec", input: { command } };
  return withFreshId(buildEvent(call, { cwd, git, task: "Fix the flaky test in auth/" }));
}

async function judged(e: ReturnType<typeof event>): Promise<AuditLine> {
  const daemon = td as TestDaemon;
  expect((await daemon.call("POST", "/v1/judge", e)).status).toBe(200);
  const line = daemon.audit().find((l) => l.event_id === e.id && l.kind === "judge");
  if (line === undefined) throw new Error("no judge line");
  return line;
}

describe("derived env.git on the audit line", () => {
  test("no env.git: judged with the derived one, recorded under derived.git", async () => {
    td = await startTestDaemon({ policies: { "ok.ts": policyModule("ok") } });
    const line = await judged(event("ls", join(repo, "sub")));
    const p = line.payload as {
      event: { env: Record<string, unknown> };
      derived: { git: unknown };
      why: { environment: string[] };
      repo_hints: { remoteHost?: string };
    };
    expect(p.derived).toEqual({ git: DERIVED });
    expect(p.event.env).not.toHaveProperty("git");
    expect(p.why.environment).toContain("default branch");
    expect(p.why.environment).not.toContain("cwd outside repo");
    expect(p.repo_hints.remoteHost).toBe("github.com");
  });

  test("the adapter's env.git is used as sent and nothing is marked derived", async () => {
    td = await startTestDaemon({ policies: { "ok.ts": policyModule("ok") } });
    const sent = { repo: "/work/repo", branch: "feat/x" };
    const line = await judged(event("ls", repo, sent));
    expect(line.payload).not.toHaveProperty("derived");
    expect((line.payload.event as { env: { git: unknown } }).env.git).toEqual(sent);
  });

  test("the observe line records derived.git too", async () => {
    td = await startTestDaemon({ policies: { "ok.ts": policyModule("ok") } });
    const call = { tool: "Bash", kind: "exec", input: { command: "cat README.md" } };
    const post = withFreshId(buildEvent(call, { cwd: repo, git: null }, { stdout: "# r" }));
    expect((await td.call("POST", "/v1/observe", post)).status).toBe(204);
    const line = td.audit().find((l) => l.event_id === post.id);
    expect(line?.payload).toMatchObject({ derived: { git: DERIVED } });
  });

  test("a git that hangs costs at most the probe budget; the event is judged without it", async () => {
    const hangs: GitRunner = () => new Promise(() => undefined);
    td = await startTestDaemon({
      policies: { "ok.ts": policyModule("ok") },
      gitRunner: hangs,
      gitProbeTimeoutMs: 100,
    });
    const started = performance.now();
    const line = await judged(event("ls", repo));
    expect(performance.now() - started).toBeLessThan(1_000);
    expect(line.payload).not.toHaveProperty("derived");
    expect(td.audit().filter((l) => l.kind === "anomaly")).toEqual([]);
  });
});
