/**
 * The Claude Code hook's rewrite and failure paths end to end (fake Claude Code, real hook
 * subprocess, real `copsd`): T9 `updatedInput`, T2 daemon down, T3 judge timeout,
 * malformed stdin, precedence against another hook, and the gap no hook can close (a
 * registered binary that cannot start).
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMockJudge } from "@jev-cops/core";
import { startTestDaemon, type TestDaemon } from "../../packages/daemon/src/testing/daemon.ts";
import { policyModule } from "../../packages/daemon/src/testing/policies.ts";
import { FakeClaudeCode, type FakeClaudeOptions } from "./testing/fake-claude.ts";
import { spawnHook } from "./testing/hook-run.ts";
import { hookCommand } from "./testing/setup.ts";

/** A rewrite policy that pins every resolved path of a relative `rm` (test-only). */
const PIN = `export default {
  name: "pin", version: 1, owner: "tests",
  when: (e) => e.commands.some((c) => c.argv[0] === "rm") && e.opaque.length === 0,
  decide: () => "rewrite",
  rewrite: (e) => ({ command: "rm -rf -- " + e.paths.join(" ") }),
  reason: "Pinned resolved paths.",
};
`;
const ASKS = policyModule(
  "asks",
  1,
  "allow",
  'ask: () => [{ kind: "noul", name: "ok", text: "Ok?" }],',
);

let work = "";
let home = "";
let td: TestDaemon | null = null;
beforeAll(() => {
  work = realpathSync(mkdtempSync(join(tmpdir(), "jvcc-e2f-")));
  home = join(work, "home");
  mkdirSync(home);
});
afterAll(() => rmSync(work, { recursive: true, force: true }));
afterEach(async () => {
  await td?.stop();
  td = null;
});

const env = (extra: Record<string, string> = {}) => ({
  PATH: process.env.PATH ?? "/usr/bin:/bin",
  HOME: home,
  ...extra,
});

function claude(socket: string, o: Partial<FakeClaudeOptions> = {}): FakeClaudeCode {
  return new FakeClaudeCode({ hooks: [hookCommand(socket)], cwd: work, env: env(), ...o });
}

describe("T9: rewrite pins the input Claude Code runs (updatedInput)", () => {
  test("rm -rf with relative and ~ paths runs as the daemon's pinned absolute form", async () => {
    td = await startTestDaemon({ policies: { "pin.ts": PIN } });
    const c = claude(td.config.daemon.socket);
    const call = await c.tool("Bash", { command: "rm -rf ./build/../dist ~/tmp", timeout: 5 });
    expect(call.decision.outcome).toBe("proceed");
    expect(call.decision.updatedInput).toEqual({ command: `rm -rf -- ${work}/dist /home/dev/tmp` });
    expect(call.ran).toEqual({ command: `rm -rf -- ${work}/dist /home/dev/tmp` });
    const observed = td.audit().find((l) => l.kind === "observe");
    const post = observed?.payload as { event: { call: { input: unknown } } };
    expect(post.event.call.input).toEqual({ command: `rm -rf -- ${work}/dist /home/dev/tmp` });
  });
});

describe("T2: daemon unreachable", () => {
  test("exec, write and MCP calls are blocked; Read and Grep proceed with a warning and a log line", async () => {
    td = await startTestDaemon({ policies: { "ok.ts": policyModule("ok") } });
    const socket = td.config.daemon.socket;
    await td.stop();
    td = null;
    const c = claude(socket);
    for (const [tool, input] of [
      ["Bash", { command: "rm -rf /srv/x" }],
      ["Edit", { file_path: join(work, "a.ts"), old_string: "a", new_string: "b" }],
      ["mcp__memory__create_entities", { entities: [] }],
    ] as const) {
      const call = await c.tool(tool, input);
      expect(call.decision.outcome).toBe("deny");
      expect(call.result).toContain("judge unreachable");
      expect(call.result).toContain("blocking (fail closed)");
    }
    for (const tool of ["Read", "Grep"]) {
      const call = await c.tool(tool, { file_path: join(work, "README.md"), pattern: "x" }, "text");
      expect(call.decision.outcome).toBe("proceed");
      expect(call.ran).not.toBeNull();
    }
    expect(c.userSees.join("\n")).toContain("read-only Read allowed (fail open)");
    const log = readFileSync(join(home, ".jev-cops", "claude-code-hook.log"), "utf8");
    expect(log).toContain(`PreToolUse sess_${c.sessionId} Read: judge unreachable`);
    expect(log).toContain(`PreToolUse sess_${c.sessionId} Bash: judge unreachable`);
  });
});

describe("T3: the judge sleeps past the hook's deadline", () => {
  test("blocked with 'judge timeout' at the hook's own deadline, long before Claude Code's", async () => {
    td = await startTestDaemon({
      policies: { "asks.ts": ASKS },
      judge: createMockJudge(
        { "asks/ok": { kind: "noul", p: 1, confidence: 1 } },
        { delayMs: 15_000 },
      ),
      judgeTimeoutMs: 20_000,
      deadlineMs: 20_000,
      policy: { ask: { min: 0 } },
    });
    const c = claude(td.config.daemon.socket, { env: env({ JEV_COPS_HOOK_DEADLINE_MS: "400" }) });
    const started = performance.now();
    const call = await c.tool("Bash", { command: "ls" });
    expect(performance.now() - started).toBeLessThan(3_000);
    expect(call.decision.outcome).toBe("deny");
    expect(call.result).toBe("jev-cops: judge timeout; blocking (fail closed)");
    expect(call.decision.hookErrors).toEqual([]);
  });
});

describe("malformed input and other handlers", () => {
  test.each([
    ["not JSON", "garbage"],
    [
      "a PreToolUse without a tool",
      JSON.stringify({ hook_event_name: "PreToolUse", session_id: "s", cwd: "/" }),
    ],
    ["an event jev-cops does not register", JSON.stringify({ hook_event_name: "Stop" })],
  ])("%s on stdin: exit 2, the call is blocked", async (_name, payload) => {
    const run = await spawnHook(hookCommand(join(work, "none.sock")), payload, {
      env: env(),
      cwd: work,
      timeoutS: 30,
      headless: false,
    });
    expect(run.exitCode).toBe(2);
    expect(run.stderr).toContain("unreadable hook payload");
  });

  test("another PreToolUse hook's allow cannot undo jev-cops's deny (deny > ask > allow)", async () => {
    td = await startTestDaemon({ policies: { "deny.ts": policyModule("deny", 1, "deny") } });
    const allow = join(work, "allow-hook.ts");
    writeFileSync(
      allow,
      'process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow" } }));\n',
    );
    const c = new FakeClaudeCode({
      hooks: [hookCommand(td.config.daemon.socket), { command: process.execPath, args: [allow] }],
      cwd: work,
      env: env(),
    });
    const call = await c.tool("Bash", { command: "ls" });
    expect(call.decision.outcome).toBe("deny");
    expect(call.ran).toBeNull();
  });

  test("gap (printed, closed only by install/doctor): a registered binary that cannot start lets the call proceed", async () => {
    const c = new FakeClaudeCode({
      hooks: [{ command: join(work, "no-such-hook"), args: [] }],
      cwd: work,
      env: env(),
    });
    const call = await c.tool("Bash", { command: "rm -rf /" });
    expect(call.decision.outcome).toBe("proceed");
    expect(call.decision.hookErrors[0]).toContain("non-blocking");
  });
});
