/**
 * `env.git` the daemon derived (D-058) as the CLI reads it back from the audit log:
 * `explain` shows its provenance, `replay` judges the event as the daemon did.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildEvent } from "../../../../tests/fixtures/context/index.ts";
import { startTestDaemon, withFreshId } from "../../../daemon/src/testing/daemon.ts";
import { makeRepo } from "../../../daemon/src/testing/git.ts";
import { policyModule } from "../../../daemon/src/testing/policies.ts";
import { captureIo } from "../io.ts";
import { runExplainCommand } from "./explain.ts";
import { runReplayCommand } from "./replay.ts";

/** Holds anything on `main`: its verdict depends on env.git alone. */
const ON_MAIN = policyModule("on-main", 1, "hold").replace(
  "when: () => true",
  'when: (e) => e.env.git?.branch === "main"',
);

let root: string;
let repo: string;
let audit: string;
let derivedId: string;
let sentId: string;

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "jevdict-derived-"));
  repo = makeRepo({ origin: "https://github.com/o/r.git", originHead: "main" });
  const td = await startTestDaemon({ policies: { "on-main.ts": ON_MAIN } });
  const bash = (git: Record<string, unknown> | null) =>
    withFreshId(
      buildEvent({ tool: "Bash", kind: "exec", input: { command: "ls" } }, { cwd: repo, git }),
    );
  const derived = bash(null);
  const sent = bash({ repo: "/work/repo", branch: "feat" });
  expect(((await td.call("POST", "/v1/judge", derived)).body as { verdict: string }).verdict).toBe(
    "hold",
  );
  await td.call("POST", "/v1/judge", sent);
  const post = withFreshId(
    buildEvent(
      { tool: "Bash", kind: "exec", input: { command: "ls" } },
      { cwd: repo, git: null },
      {
        stdout: "README.md",
      },
    ),
  );
  await td.call("POST", "/v1/observe", post);
  await td.daemon.stop();
  audit = join(root, "audit.jsonl");
  await Bun.write(audit, Bun.file(td.config.audit.path));
  rmSync(td.dir, { recursive: true, force: true });
  derivedId = derived.id;
  sentId = sent.id;
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(repo, { recursive: true, force: true });
});

describe("derived env.git in the CLI", () => {
  test("explain says which env.git fields jevdictd derived from cwd", async () => {
    const io = captureIo();
    expect(await runExplainCommand([derivedId, "--audit", audit], io)).toBe(0);
    expect(io.stdout.join("\n")).toContain(
      `env.git: repo ${repo} · branch main · default main · dirty no (derived by jevdictd from cwd: repo, branch, dirty, default_branch)`,
    );
    const sent = captureIo();
    expect(await runExplainCommand([sentId, "--audit", audit], sent)).toBe(0);
    expect(sent.stdout.join("\n")).toContain(
      "env.git: repo /work/repo · branch feat · default unknown · dirty unknown (sent by the adapter)",
    );
  });

  test("replay judges the event with the derived env.git: no delta", async () => {
    const dir = join(root, "policies");
    mkdirSync(dir);
    writeFileSync(join(dir, "on-main.ts"), ON_MAIN);
    const io = captureIo();
    expect(await runReplayCommand([audit, "--policies", dir], io)).toBe(0);
    const text = io.stdout.join("\n");
    expect(text).toContain("2 judged event(s)");
    expect(text).toMatch(/^0 deltas$/m);
  });
});
