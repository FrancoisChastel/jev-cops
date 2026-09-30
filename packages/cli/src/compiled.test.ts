import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CLAUDE_CODE_GAPS } from "@jev-cops/adapter-claude-code";
import { PI_GAPS } from "@jev-cops/adapter-pi/install";
import { startTestDaemon } from "../../daemon/src/testing/daemon.ts";
import { policyModule } from "../../daemon/src/testing/policies.ts";

/**
 * The compiled binary must carry the tree-sitter WASM and the SDK itself: it is built into
 * a temp directory and run against a copy of the starter policies outside the repo, where
 * no node_modules or tsconfig path can help it.
 */
const REPO = join(import.meta.dir, "..", "..", "..");
let dir: string;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "jev-cops-bin-"));
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
      join(dir, "cops"),
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  if ((await build.exited) !== 0) throw new Error(await new Response(build.stderr).text());
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("compiled jev-cops", () => {
  test("hook --harness claude-code judges stdin through the daemon, like dist/cops-hook", async () => {
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
        [join(dir, "cops"), "hook", "--harness", "claude-code", "--socket", socket],
        {
          env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: dir },
          stdin: payload,
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      expect(await run.exited).toBe(2);
      expect(JSON.parse(await new Response(run.stdout).text())).toMatchObject({
        hookSpecificOutput: {
          permissionDecision: "deny",
          permissionDecisionReason: "jev-cops: no",
        },
      });
      expect(await new Response(run.stderr).text()).toBe("jev-cops: no\n");
    } finally {
      server.stop(true);
    }
  }, 30_000);

  test("runs the starter fixtures outside the repo", async () => {
    const run = Bun.spawn([join(dir, "cops"), "test", "policies"], { cwd: dir, stdout: "pipe" });
    const out = await new Response(run.stdout).text();
    expect(await run.exited).toBe(0);
    expect(out).toContain("0 failed · 0 problems → PASS");
  }, 60_000);

  test("doctor runs from the binary (read-only; PATH holds no claude or pi)", async () => {
    const td = await startTestDaemon({ policies: { "ok.ts": policyModule("ok") } });
    try {
      const [home, bin, project] = ["doctor-home", "doctor-bin", "doctor-project"].map((d) => {
        mkdirSync(join(dir, d));
        return join(dir, d);
      }) as [string, string, string];
      const toml = join(dir, "doctor.toml");
      const { socket, adminSocket } = td.config.daemon;
      const lines = ["[daemon]", `socket = ${JSON.stringify(socket)}`];
      lines.push(`admin_socket = ${JSON.stringify(adminSocket)}`, "[audit]");
      lines.push(`path = ${JSON.stringify(td.config.audit.path)}`);
      writeFileSync(toml, `${lines.join("\n")}\n`);
      const argv = [join(dir, "cops"), "doctor", "--json", "--config", toml, "--home", home];
      const env = { PATH: bin, HOME: home };
      const run = Bun.spawn(argv, { cwd: project, env, stdout: "pipe", stderr: "pipe" });
      const out = await new Response(run.stdout).text();
      expect(await run.exited).toBe(0);
      const report = JSON.parse(out) as {
        counts: Record<string, number>;
        checks: { name: string; status: string }[];
      };
      expect(report.checks.find((c) => c.name === "agent socket")?.status).toBe("ok");
      expect(report.checks.find((c) => c.name === "chain")?.status).toBe("ok");
      expect(report.counts.gap).toBe(CLAUDE_CODE_GAPS.length + PI_GAPS.length);
    } finally {
      await td.stop();
    }
  }, 30_000);
});
