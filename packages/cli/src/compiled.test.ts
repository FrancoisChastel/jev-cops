import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { cpSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * The compiled binary must carry the tree-sitter WASM and the SDK itself: it is built into
 * a temp directory and run against a copy of the starter policies outside the repo, where
 * no node_modules or tsconfig path can help it.
 */
const REPO = join(import.meta.dir, "..", "..", "..");
let dir: string;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "jevdict-bin-"));
  cpSync(join(REPO, "policies"), join(dir, "policies"), {
    recursive: true,
    filter: (src) => !src.endsWith(".test.ts"),
  });
  const build = Bun.spawn(
    [
      "bun",
      "build",
      "--compile",
      join(REPO, "packages/cli/src/main.ts"),
      "--outfile",
      join(dir, "jevdict"),
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  if ((await build.exited) !== 0) throw new Error(await new Response(build.stderr).text());
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("compiled jevdict", () => {
  test("hook --harness claude-code judges stdin through the daemon, like dist/jevdict-hook", async () => {
    const socket = join(dir, "d.sock");
    const server = Bun.serve({
      unix: socket,
      fetch: async (req) => {
        const e = (await req.json()) as { id: string };
        return Response.json({ event_id: e.id, verdict: "deny", reason: "no" });
      },
    });
    try {
      const payload = readFileSync(join(REPO, "tests/fixtures/claude-code/pre-tool-use.bash.json"));
      const run = Bun.spawn(
        [join(dir, "jevdict"), "hook", "--harness", "claude-code", "--socket", socket],
        {
          env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: dir },
          stdin: payload,
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      expect(await run.exited).toBe(2);
      expect(JSON.parse(await new Response(run.stdout).text())).toMatchObject({
        hookSpecificOutput: { permissionDecision: "deny", permissionDecisionReason: "jevdict: no" },
      });
      expect(await new Response(run.stderr).text()).toBe("jevdict: no\n");
    } finally {
      server.stop(true);
    }
  }, 30_000);

  test("runs the starter fixtures outside the repo", async () => {
    const run = Bun.spawn([join(dir, "jevdict"), "test", "policies"], { cwd: dir, stdout: "pipe" });
    const out = await new Response(run.stdout).text();
    expect(await run.exited).toBe(0);
    expect(out).toContain("0 failed · 0 problems → PASS");
  }, 60_000);
});
