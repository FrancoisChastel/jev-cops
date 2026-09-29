/**
 * T2 — Daemon killed or unreachable (spec §Threat model).
 *
 * Attack: Agent stops `jevdictd` or blocks the socket
 * Required outcome: Adapter fails closed for any event a `deny`-class policy could match; observe-only events log locally and continue
 *
 * Status: live (daemon side): an internal failure answers non-200 with an `anomaly` audit
 * line, never a verdict, so the adapter's "non-200 = unreachable" rule applies; a socket
 * nobody listens on refuses connections. Live (Pi adapter): with the daemon stopped, exec,
 * write and unknown tools are blocked; read-only tools continue and warn locally. The
 * Claude Code adapter's fail-closed hook is M1.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { register } from "../../adapters/pi/jevdict.ts";
import { FakePi, fakeContext } from "../../adapters/pi/testing/fake-pi.ts";
import {
  startTestDaemon,
  type TestDaemon,
  withFreshId,
} from "../../packages/daemon/src/testing/daemon.ts";
import { policyModule } from "../../packages/daemon/src/testing/policies.ts";
import { buildEvent } from "../fixtures/context/index.ts";
import { pending } from "./pending.ts";

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

  test.todo(`Claude Code: ${REQUIRED_OUTCOME}`, pending("M1 (Claude Code hooks)"));
});
