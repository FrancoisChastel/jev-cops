import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildEvent } from "../../../tests/fixtures/context/index.ts";
import { startTestDaemon, type TestDaemon, withFreshId } from "./testing/daemon.ts";
import { waitFor } from "./testing/forward-contract.ts";
import { policyModule } from "./testing/policies.ts";

let td: TestDaemon | null = null;
const dirs: string[] = [];

afterEach(async () => {
  await td?.stop();
  td = null;
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

interface AuditHealth {
  head_seq: number;
  forward: null | {
    kind: string;
    connected: boolean;
    sent_seq: number;
    lag_lines: number;
    lag_ms: number;
    last_error: string | null;
    required: boolean;
  };
}

async function health(d: TestDaemon): Promise<AuditHealth> {
  const reply = await d.call("GET", "/v1/health");
  return (reply.body as { audit: AuditHealth }).audit;
}

function fileForward(dir: string) {
  return {
    kind: "file" as const,
    target: join(dir, "remote", "copy.jsonl"),
    required: false,
    maxLagLines: 1_000,
    maxLagMs: 60_000,
    cursor: join(dir, "forward.cursor"),
    syslog: null,
  };
}

describe("copsd with [audit.forward] kind = file", () => {
  test("every line reaches the copy; health reports the forwarder caught up", async () => {
    const dir = mkdtempSync(join(tmpdir(), "jvf-"));
    dirs.push(dir);
    const d = await startTestDaemon({
      policies: { "ok.ts": policyModule("ok") },
      forward: fileForward(dir),
    });
    td = d;
    const event = withFreshId(buildEvent({ tool: "Bash", kind: "exec", input: { command: "ls" } }));
    await d.call("POST", "/v1/judge", event);
    const caught = await waitFor(
      () => health(d),
      (h) => h.forward?.lag_lines === 0 && h.forward.connected,
    );
    expect(caught.forward).toMatchObject({ kind: "file", connected: true, required: false });
    expect(caught.forward?.sent_seq).toBe(caught.head_seq);
    const copy = readFileSync(join(dir, "remote", "copy.jsonl"), "utf8");
    expect(copy).toBe(readFileSync(d.config.audit.path, "utf8"));
  });

  test("without a forwarder the health block says so", async () => {
    td = await startTestDaemon({ policies: { "ok.ts": policyModule("ok") } });
    const h = await health(td);
    expect(h.forward).toBeNull();
    expect(h.head_seq).toBeGreaterThan(0);
  });
});
