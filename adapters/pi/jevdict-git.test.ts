/**
 * Pi sends no `env.git` (D-058); jevdictd derives it from the call's cwd. Driven by the
 * fake Pi runner against a real daemon with the repo's own `policies/`, from inside a
 * real temp repository whose default branch comes from `origin/HEAD`.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AuditLine } from "../../packages/daemon/src/audit.ts";
import { startTestDaemon, type TestDaemon } from "../../packages/daemon/src/testing/daemon.ts";
import { makeRepo } from "../../packages/daemon/src/testing/git.ts";
import { register } from "./jevdict.ts";
import { FakePi, fakeContext } from "./testing/fake-pi.ts";

const REPO_POLICIES = join(import.meta.dir, "..", "..", "policies");
const TASK = "Fix the flaky test in auth/";
const GUARD_REASON = "Irreversible git operation on the default branch.";

let td: TestDaemon;
let repo: string;
let plain: string;
beforeAll(async () => {
  td = await startTestDaemon({ policies: {}, policiesDir: REPO_POLICIES });
  repo = makeRepo({
    files: { "README.md": "# app\n", "sub/a.ts": "export {};\n", "lib/build/x": "x" },
    origin: "https://github.com/example/app.git",
    originHead: "main",
  });
  plain = realpathSync(mkdtempSync(join(tmpdir(), "jvpi-plain-")));
});
afterAll(async () => {
  await td.stop();
  rmSync(repo, { recursive: true, force: true });
  rmSync(plain, { recursive: true, force: true });
});

async function session(cwd: string) {
  const pi = new FakePi();
  register(pi, { socket: td.config.daemon.socket });
  const ctx = fakeContext({ cwd, sessionId: crypto.randomUUID() });
  await pi.sessionStart("startup", ctx);
  await pi.beforeAgentStart(TASK, ctx);
  return { pi, ctx };
}

function lastJudge(): { payload: Record<string, unknown> } & AuditLine {
  const line = td.audit().findLast((l) => l.kind === "judge");
  if (line === undefined) throw new Error("no judge line");
  return line;
}

type Payload = {
  derived?: { git: Record<string, unknown> };
  decision: { detail: string; policies: string[]; features: Record<string, number> };
  why: { environment: string[]; scope: string[] };
};

describe("Pi end to end: jevdictd derives env.git from the call's cwd", () => {
  test("`git push --force` with no refspec on main: the guard matches on the branch", async () => {
    const { pi, ctx } = await session(join(repo, "sub"));
    const run = await pi.run(ctx, "bash", { command: "git push --force" });
    expect(run.blocked?.reason).toContain(GUARD_REASON);
    const p = lastJudge().payload as unknown as Payload;
    expect(p.derived?.git).toEqual({
      repo,
      branch: "main",
      default_branch: "main",
      dirty: false,
    });
    expect(p.decision.policies).toContain("default-branch-guard@2");
    expect(p.decision.detail).toContain("branch main; default main");
    expect(p.why.environment).toContain("default branch");
  });

  test("the same push outside any repo: no branch, so no default-branch match", async () => {
    const { pi, ctx } = await session(plain);
    const run = await pi.run(ctx, "bash", { command: "git push --force" });
    expect(run.blocked?.reason ?? "").not.toContain(GUARD_REASON);
    const p = lastJudge().payload as unknown as Payload;
    expect(p).not.toHaveProperty("derived");
    expect(p.decision.policies).not.toContain("default-branch-guard@2");
  });

  test("scope uses the repo root, not the cwd: a sibling directory is in the repo", async () => {
    const inRepo = await session(join(repo, "sub"));
    const run = await inRepo.pi.run(inRepo.ctx, "bash", { command: "rm -rf ../lib/build" });
    expect(run.blocked).toBeUndefined();
    const derived = lastJudge().payload as unknown as Payload;
    expect(derived.decision.features.scope).toBe(1);
    expect(derived.why.scope).toEqual(["all targets on task"]);
    mkdirSync(join(plain, "sub"), { recursive: true });
    const noRepo = await session(join(plain, "sub"));
    await noRepo.pi.run(noRepo.ctx, "bash", { command: "rm -rf ../lib/build" });
    const bare = lastJudge().payload as unknown as Payload;
    expect(bare.decision.features.scope).toBe(0);
    expect(bare.why.scope).toContain(`outside repo: ${plain}/lib/build`);
  });
});
