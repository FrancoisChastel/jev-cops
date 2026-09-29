/**
 * Hold → deny when no human can answer (D-008 extended, plan §5 rows 10–11). The canonical
 * event carries `session.mode` only; Claude Code's permission mode reaches the daemon
 * through `/v1/session` reports and is cached per root session.
 */
import { afterEach, describe, expect, test } from "bun:test";
import type { PreEvent, VerdictResponse } from "@jevdict/core";
import { buildEvent, type EventShape } from "../../../tests/fixtures/context/index.ts";
import { startTestDaemon, type TestDaemon, withFreshId } from "./testing/daemon.ts";
import { policyModule } from "./testing/policies.ts";
import { type ReportShape, sessionReport, TEST_SESSION } from "./testing/session.ts";
import { HEADLESS_HOLD_DENIED, PERMISSION_MODE_HOLD_DENIED } from "./verdict-map.ts";

const GUARD = policyModule("guard", 1, "hold").replace(
  "when: () => true",
  'when: (e) => e.kind === "fs.delete"',
);

let td: TestDaemon | null = null;
afterEach(async () => {
  await td?.stop();
  td = null;
});

async function daemon(): Promise<TestDaemon> {
  td = await startTestDaemon({ policies: { "guard.ts": GUARD } });
  return td;
}

/** The fixture's pre event without `session.mode`, as an adapter that does not know it. */
function withoutMode(e: PreEvent): PreEvent {
  const { mode: _unknown, ...session } = e.session;
  return { ...e, session };
}

async function holdable(t: TestDaemon, shape: EventShape = {}, keepMode = true) {
  const input = { command: "rm -rf /srv/data" };
  const built = withFreshId(buildEvent({ tool: "Bash", kind: "exec", input }, shape) as PreEvent);
  const e = keepMode ? built : withoutMode(built);
  const res = await t.call("POST", "/v1/judge", e);
  const line = t.audit().find((l) => l.event_id === e.id);
  return { body: res.body as VerdictResponse, mapping: line?.payload.mapping };
}

async function start(t: TestDaemon, shape: ReportShape) {
  expect((await t.call("POST", "/v1/session", sessionReport("start", {}, shape))).status).toBe(200);
}

describe("permission modes that never prompt turn a hold into a deny", () => {
  test.each(["bypassPermissions", "dontAsk", "someFutureMode"])("%s", async (permissionMode) => {
    const t = await daemon();
    await start(t, { permissionMode });
    const { body, mapping } = await holdable(t);
    expect(body.verdict).toBe("deny");
    expect(body).not.toHaveProperty("hold_token");
    expect(mapping).toEqual([PERMISSION_MODE_HOLD_DENIED]);
  });

  test.each(["default", "plan", "acceptEdits", "auto"])("%s still asks", async (permissionMode) => {
    const t = await daemon();
    await start(t, { permissionMode });
    expect((await holdable(t)).body.verdict).toBe("hold");
  });

  test("no report at all: the hold stands (the adapter maps modes it sees itself)", async () => {
    const t = await daemon();
    expect((await holdable(t)).body.verdict).toBe("hold");
  });

  test("sticky: switching back to default later does not turn denies into asks", async () => {
    const t = await daemon();
    await start(t, { permissionMode: "bypassPermissions" });
    const back = sessionReport("prompt", { prompt: "t" }, { permissionMode: "default" });
    await t.call("POST", "/v1/session", back);
    expect((await holdable(t)).body.verdict).toBe("deny");
  });

  test("a subagent follows its root's facts", async () => {
    const t = await daemon();
    await start(t, { permissionMode: "dontAsk" });
    const sub = { sessionId: `${TEST_SESSION}.agent_1`, parentId: TEST_SESSION } as const;
    expect((await holdable(t, sub)).body.verdict).toBe("deny");
  });
});

describe("headless", () => {
  test("a headless start covers events that carry no mode", async () => {
    const t = await daemon();
    await start(t, { mode: "headless" });
    const { body, mapping } = await holdable(t, {}, false);
    expect(body.verdict).toBe("deny");
    expect(mapping).toEqual([HEADLESS_HOLD_DENIED]);
  });

  test("the event's own headless mode wins over an interactive report", async () => {
    const t = await daemon();
    await start(t, { mode: "interactive", permissionMode: "bypassPermissions" });
    const { mapping } = await holdable(t, { mode: "headless" });
    expect(mapping).toEqual([HEADLESS_HOLD_DENIED]);
  });
});
