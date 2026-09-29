import { describe, expect, test } from "bun:test";
import {
  bashPre,
  CTX_HOME,
  CTX_SESSION,
  toolEvent,
} from "../../../../tests/fixtures/context/index.ts";
import { createCaseFile } from "./casefile.ts";
import { resolveContextConfig } from "./config.ts";
import { reversibilityScore } from "./reversibility.ts";
import type { CaseFile } from "./types.ts";

const CFG = resolveContextConfig({ home: CTX_HOME });

function caseFile(): CaseFile {
  return createCaseFile(CTX_SESSION, { config: { home: CTX_HOME } });
}

async function score(command: string, cf = caseFile()): Promise<number> {
  return reversibilityScore(await bashPre(command), cf, CFG).value;
}

describe("reversibilityScore", () => {
  test.each([
    ["cat README.md", 0],
    ["npm test", 0],
    ["echo hi > notes.md", 0],
    ["touch /tmp/scratch", 0],
    ["rm node_modules/.cache/x", 0.5],
    ["rm /tmp/build.log", 1],
    ["rm -rf node_modules", 1],
    ["rm -r /home/dev/old", 1],
    ["cp a.txt /etc/cron.d/job", 1],
    ["git push --force origin main", 1],
    ["git reset --hard HEAD~3", 1],
    ["sudo ls", 1],
    ["curl -X POST https://api.example/x -d a=1", 1],
    ["curl -X DELETE https://api.example/x", 1],
    ["curl -T file.bin https://api.example/up", 1],
    ["curl https://brand-new.example", 0.5],
    ['eval "$CMD"', 0.5],
    ["docker run img", 0],
    ["docker run -e GITHUB_TOKEN=abc img", 1],
    ["AWS_SECRET_ACCESS_KEY=x nohup ./srv", 1],
  ])("%s → %p", async (command, expected) => {
    expect(await score(command)).toBe(expected);
  });

  test("a GET to a host seen before is reversible", async () => {
    const cf = caseFile();
    cf.recordPre(await bashPre("curl https://docs.example/a"));
    expect(await score("curl https://docs.example/b", cf)).toBe(0);
  });

  test("tool events: Edit under the repo 0, Write outside 1, Read 0, Task 0, MCP opaque 0.5", async () => {
    const cf = caseFile();
    const value = async (tool: string, kind: string, input: Record<string, unknown>) =>
      reversibilityScore(await toolEvent(tool, kind, input), cf, CFG).value;
    expect(await value("Edit", "fs.write", { file_path: "src/a.ts" })).toBe(0);
    expect(await value("Write", "fs.write", { file_path: "/home/dev/.bashrc" })).toBe(1);
    expect(await value("Read", "fs.read", { file_path: "/etc/hosts" })).toBe(0);
    expect(await value("Task", "spawn", { prompt: "go" })).toBe(0);
    expect(await value("mcp:db:query", "other", { sql: "drop table x" })).toBe(0.5);
  });

  test("without a repo, writes outside /tmp are irreversible", async () => {
    const n = await bashPre("echo hi > notes.md", { git: null, cwd: "/work/scratch" });
    expect(reversibilityScore(n, caseFile(), CFG).value).toBe(1);
  });

  test("why names the irreversible reason", async () => {
    const n = await bashPre("git push --force");
    expect(reversibilityScore(n, caseFile(), CFG).why).toEqual([
      "irreversible verb: force, irreversible",
    ]);
  });
});
