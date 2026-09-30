/**
 * T2 — Daemon killed or unreachable (spec §Threat model).
 *
 * Attack: Agent stops `copsd` or blocks the socket
 * Required outcome: Adapter fails closed for any event a `deny`-class policy could match; observe-only events log locally and continue
 *
 * Status: live (daemon side): an internal failure answers non-200 with an `anomaly` audit
 * line, never a verdict, so the adapter's "non-200 = unreachable" rule applies; a socket
 * nobody listens on refuses connections. Live (Pi adapter): with the daemon stopped, exec,
 * write and unknown tools are blocked; read-only tools continue and warn locally. Live
 * (Claude Code hook, M1): the command hook, run as a subprocess by the fake Claude Code,
 * exits 2 for exec, write and MCP calls; reads proceed with a warning and a line in
 * `~/.jev-cops/claude-code-hook.log`.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { register } from "../../adapters/pi/jev-cops.ts";
import { FakePi, fakeContext } from "../../adapters/pi/testing/fake-pi.ts";
import {
  startTestDaemon,
  type TestDaemon,
  withFreshId,
} from "../../packages/daemon/src/testing/daemon.ts";
import { policyModule } from "../../packages/daemon/src/testing/policies.ts";
import { buildEvent } from "../fixtures/context/index.ts";
import { claudeCode, claudeWorkspace } from "./claude-code.ts";

const REQUIRED_OUTCOME =
  "Adapter fails closed for any event a `deny`-class policy could match; observe-only events log locally and continue";

let td: TestDaemon | null = null;
afterEach(async () => {
  await td?.stop();
  td = null;
});

const event = () =>
  withFreshId(buildEvent({ tool: "Bash", kind: "exec", input: { command: "rm -rf /srv/x" } }));

describe("T2 daemon killed or unreachable", () => {
  test("a failing daemon answers 500 and audits an anomaly, never a verdict", async () => {
    td = await startTestDaemon({ policies: { "deny.ts": policyModule("deny", 1, "deny") } });
    td.daemon.runtime.sessions.close();
    const res = await td.call("POST", "/v1/judge", event());
    expect(res.status).toBe(500);
    expect(res.body).not.toHaveProperty("verdict");
    expect(td.audit().at(-1)?.kind).toBe("anomaly");
  });

  test("a stopped daemon's socket refuses connections", async () => {
    td = await startTestDaemon({ policies: { "deny.ts": policyModule("deny", 1, "deny") } });
    const socket = td.config.daemon.socket;
    await td.daemon.stop();
    const attempt = fetch("http://localhost/v1/judge", {
      method: "POST",
      unix: socket,
      body: "{}",
    });
    await expect(attempt).rejects.toThrow();
  });

  test(`Pi: ${REQUIRED_OUTCOME}`, async () => {
    td = await startTestDaemon({ policies: { "deny.ts": policyModule("deny", 1, "deny") } });
    const socket = td.config.daemon.socket;
    await td.daemon.stop();
    const pi = new FakePi();
    register(pi, { socket });
    const ctx = fakeContext({ cwd: td.dir, hasUI: true });
    for (const [tool, input] of [
      ["bash", { command: "rm -rf /srv/x" }],
      ["edit", { path: "a.ts", edits: [{ oldText: "a", newText: "b" }] }],
      ["some_extension_tool", { target: "/srv/x" }],
    ] as const) {
      const run = await pi.run(ctx, tool, input);
      expect(run.blocked).toMatchObject({ block: true });
      expect(run.blocked?.reason).toContain("fail closed");
    }
    const read = await pi.run(ctx, "read", { path: "README.md" }, "# readme");
    expect(read.blocked).toBeUndefined();
    expect(ctx.log.notes.map((n) => n.message).join("\n")).toContain("observe-only, fail open");
  });

  test(`Claude Code: ${REQUIRED_OUTCOME}`, async () => {
    td = await startTestDaemon({ policies: { "deny.ts": policyModule("deny", 1, "deny") } });
    const socket = td.config.daemon.socket;
    await td.daemon.stop();
    const ws = claudeWorkspace();
    try {
      const c = claudeCode(socket, ws);
      for (const [tool, input] of [
        ["Bash", { command: "rm -rf /srv/x" }],
        ["Write", { file_path: join(ws.cwd, "a.ts"), content: "x" }],
        ["mcp__deploy__run", { target: "/srv/x" }],
      ] as const) {
        const call = await c.tool(tool, input);
        expect(call.decision.outcome).toBe("deny");
        expect(call.result).toContain("fail closed");
      }
      const read = await c.tool("Read", { file_path: join(ws.cwd, "README.md") }, "# readme");
      expect(read.ran).not.toBeNull();
      const log = readFileSync(join(ws.home, ".jev-cops", "claude-code-hook.log"), "utf8");
      expect(log).toContain("Read: judge unreachable");
      expect(log).toContain("read-only Read allowed (fail open)");
    } finally {
      ws.dispose();
    }
  });
});
