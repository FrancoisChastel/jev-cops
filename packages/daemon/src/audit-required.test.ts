import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildEvent } from "../../../tests/fixtures/context/index.ts";
import { linesFromMessages } from "./audit-forward/syslog-parse.ts";
import type { AuditForward } from "./config.ts";
import { startTestDaemon, type TestDaemon, withFreshId } from "./testing/daemon.ts";
import { waitFor } from "./testing/forward-contract.ts";
import { policyModule } from "./testing/policies.ts";
import { type SyslogReceiver, startSyslogReceiver } from "./testing/syslog-receiver.ts";

let td: TestDaemon | null = null;
let receiver: SyslogReceiver | null = null;
const dirs: string[] = [];

afterEach(async () => {
  await td?.stop();
  await receiver?.close();
  td = null;
  receiver = null;
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function syslogForward(r: SyslogReceiver, over: Partial<AuditForward> = {}): AuditForward {
  const dir = mkdtempSync(join(tmpdir(), "jvs-"));
  dirs.push(dir);
  writeFileSync(join(dir, "ca.pem"), r.cert.cert);
  return {
    kind: "syslog",
    target: `127.0.0.1:${r.port}`,
    required: false,
    maxLagLines: 1_000,
    maxLagMs: 600_000,
    cursor: join(dir, "forward.cursor"),
    syslog: {
      host: "127.0.0.1",
      port: r.port,
      ca: join(dir, "ca.pem"),
      cert: null,
      key: null,
      serverName: null,
      facility: 16,
      appName: "copsd",
      enterpriseNumber: 32473,
      maxMessageBytes: 8192,
      resendOverlap: 100,
    },
    ...over,
  };
}

const exec = () =>
  withFreshId(buildEvent({ tool: "Bash", kind: "exec", input: { command: "ls" } }));
const read = () =>
  withFreshId(buildEvent({ tool: "Read", kind: "fs.read", input: { file_path: "/tmp/x" } }));

async function lag(d: TestDaemon): Promise<{ connected: boolean; lag_lines: number } | null> {
  const body = (await d.call("GET", "/v1/health")).body as {
    audit: { forward: { connected: boolean; lag_lines: number } | null };
  };
  return body.audit.forward;
}

describe("copsd with [audit.forward] kind = syslog", () => {
  test("every line reaches the receiver over TLS", async () => {
    receiver = await startSyslogReceiver();
    const r = receiver;
    const d = await startTestDaemon({
      policies: { "ok.ts": policyModule("ok") },
      forward: syslogForward(r),
    });
    td = d;
    await d.call("POST", "/v1/judge", exec());
    await waitFor(
      () => lag(d),
      (f) => f?.connected === true && f.lag_lines === 0,
    );
    const got = await waitFor(
      () => linesFromMessages(r.messages()).lines,
      (l) => l.length >= d.audit().length,
    );
    expect(got).toEqual(d.audit());
  });

  test("not required (the default): judging goes on while the receiver is down", async () => {
    receiver = await startSyslogReceiver();
    await receiver.stop();
    td = await startTestDaemon({
      policies: { "ok.ts": policyModule("ok") },
      forward: syslogForward(receiver, { maxLagLines: 1 }),
    });
    for (let i = 0; i < 3; i++)
      expect((await td.call("POST", "/v1/judge", exec())).status).toBe(200);
  });
});

describe("[audit.forward] required = true (fail closed by opt-in)", () => {
  test("past the lag limit the deny class is refused (503), reads are still judged, then it recovers", async () => {
    receiver = await startSyslogReceiver();
    const r = receiver;
    await r.stop();
    const d = await startTestDaemon({
      policies: { "ok.ts": policyModule("ok") },
      forward: syslogForward(r, { required: true, maxLagLines: 1 }),
    });
    td = d;
    expect((await d.call("POST", "/v1/judge", exec())).status).toBe(200);
    const refused = await d.call("POST", "/v1/judge", exec());
    expect(refused.status).toBe(503);
    expect(refused.body).toMatchObject({ error: "audit forwarder down" });
    const anomaly = d.audit().findLast((l) => l.kind === "anomaly");
    expect(anomaly?.payload).toMatchObject({
      reason: "audit forwarding required: deny-class call refused",
    });
    expect((await d.call("POST", "/v1/judge", read())).status).toBe(200);
    await r.start();
    await waitFor(
      () => lag(d),
      (f) => f?.lag_lines === 0,
    );
    expect((await d.call("POST", "/v1/judge", exec())).status).toBe(200);
    const got = await waitFor(
      () => linesFromMessages(r.messages()).lines,
      (l) => l.length >= d.audit().length,
    );
    expect(got).toEqual(d.audit());
  });

  test("time behind counts too", async () => {
    receiver = await startSyslogReceiver();
    await receiver.stop();
    const d = await startTestDaemon({
      policies: { "ok.ts": policyModule("ok") },
      forward: syslogForward(receiver, { required: true, maxLagMs: 50 }),
    });
    td = d;
    await Bun.sleep(80);
    const reply = await d.call("POST", "/v1/judge", exec());
    expect(reply.status).toBe(503);
    expect(String((reply.body as { reason: string }).reason)).toContain("max_lag_ms 50");
  });
});
