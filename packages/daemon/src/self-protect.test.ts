import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import type { Event, VerdictResponse } from "@jevdict/core";
import { buildEvent } from "../../../tests/fixtures/context/index.ts";
import { startTestDaemon, type TestDaemon, withFreshId } from "./testing/daemon.ts";
import { policyModule } from "./testing/policies.ts";

/**
 * The daemon protects its own inputs (PLAN-M1 §4.5 "Jevdict" row): through a real
 * jevdictd running the repo's starter policies, `config-tamper` kills a write to the
 * policies dir, the audit log, the config file or the hook binary, because the daemon
 * appended them to `[policy] protectedPaths` at startup, not because a test configured them.
 */

const POLICIES = join(import.meta.dir, "..", "..", "..", "policies");
const HOOK = "/opt/jv/bin/jevdict-hook";

let td: TestDaemon;

beforeAll(async () => {
  td = await startTestDaemon({ policies: {}, policiesDir: POLICIES, hookBinary: HOOK });
});

afterAll(async () => {
  await td.stop();
});

type Shape = { tool: string; kind: "exec" | "fs.write"; input: Record<string, unknown> };

async function judge(shape: Shape): Promise<{ body: VerdictResponse; event: Event }> {
  // A fresh session per call: a kill latches its session, the next call must not inherit it.
  const event = withFreshId(buildEvent(shape, { sessionId: `sess_self_${crypto.randomUUID()}` }));
  const res = await td.call("POST", "/v1/judge", event);
  return { body: res.body as VerdictResponse, event };
}

const bash = (command: string) => judge({ tool: "Bash", kind: "exec", input: { command } });
const write = (file_path: string) =>
  judge({ tool: "Write", kind: "fs.write", input: { file_path, content: "x" } });

function configTamperTrace(eventId: string) {
  const line = td.audit().find((l) => l.kind === "judge" && l.event_id === eventId);
  const decision = line?.payload.decision as { trace: { policy: string; matched: boolean }[] };
  return decision.trace.find((t) => t.policy.startsWith("config-tamper@"));
}

describe("the daemon's own paths are killed by config-tamper", () => {
  test("Bash `echo x > <policies dir>/p.ts` is a kill", async () => {
    const { body } = await bash(`echo x > ${td.config.policies.dir}/p.ts`);
    expect(body.verdict).toBe("kill");
    expect(body.reason).toContain(td.config.policies.dir);
  });

  test("a Write to the audit file is a kill", async () => {
    expect((await write(td.config.audit.path)).body.verdict).toBe("kill");
  });

  test("a Write to the daemon's config file is a kill", async () => {
    expect((await write(join(td.dir, "jevdict.toml"))).body.verdict).toBe("kill");
  });

  test("a copy over the configured hook binary is a kill", async () => {
    expect((await bash(`cp /tmp/evil ${HOOK}`)).body.verdict).toBe("kill");
  });

  test("`cat <audit file>` is a read: config-tamper does not match", async () => {
    const { body, event } = await bash(`cat ${td.config.audit.path}`);
    expect(body.verdict).not.toBe("kill");
    expect(configTamperTrace(event.id)?.matched).toBe(false);
  });

  test("still killed after a policy reload", async () => {
    td.writePolicy("zz-noop.ts", policyModule("zz-noop"));
    const reloaded = await td.daemon.runtime.policies.reload();
    expect(reloaded.applied).toBe(true);
    expect((await write(td.config.audit.path)).body.verdict).toBe("kill");
  });
});

describe("the protected set is visible", () => {
  test("/v1/health lists how many paths are protected", async () => {
    const res = await td.call("GET", "/v1/health");
    const count = (td.daemon.runtime.config.policy.protectedPaths ?? []).length;
    expect(count).toBeGreaterThanOrEqual(8);
    expect(res.body).toMatchObject({ protected_paths: count });
  });

  test("the boot audit line carries the effective list, so replay judges with it", () => {
    const boot = td.audit().find((l) => l.kind === "boot" && l.payload.event === "boot");
    const config = boot?.payload.config as { policy: { protectedPaths?: string[] } };
    expect(config.policy.protectedPaths).toContain(td.config.policies.dir);
    expect(config.policy.protectedPaths).toContain(td.config.audit.path);
  });
});
