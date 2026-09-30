/**
 * The kill latch end to end (D-072 proposal, plan §5 row 13): a `kill` terminates the
 * session, so every later `/v1/judge` of it (or of a subagent under its root) answers
 * `kill` without running a policy, `/v1/session` says `killed: true`, and only the admin
 * socket can clear it.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { parseVerdict, type VerdictResponse } from "@jev-cops/core";
import { buildEvent, type EventShape } from "../../../tests/fixtures/context/index.ts";
import { startTestDaemon, type TestDaemon, withFreshId } from "./testing/daemon.ts";
import { policyModule } from "./testing/policies.ts";
import { sessionReport, TEST_SESSION } from "./testing/session.ts";
import { SESSION_KILLED, SESSION_KILLED_REASON } from "./verdict-map.ts";

const KILLER = policyModule("killer", 1, "kill").replace(
  "when: () => true",
  "when: (e) => e.paths.some((p) => p.includes('killme'))",
);
/** Counts every `when` call in `globalThis.__latchProbe`, so a test can see no policy ran. */
const PROBE = policyModule("probe", 1, "allow").replace(
  "when: () => true",
  "when: () => { globalThis.__latchProbe = (globalThis.__latchProbe ?? 0) + 1; return false; }",
);
const SUB = `${TEST_SESSION}.agent_1`;

type Probe = typeof globalThis & { __latchProbe?: number };

let td: TestDaemon | null = null;
afterEach(async () => {
  await td?.stop();
  td = null;
});

async function daemon(mode: "enforce" | "observe" = "enforce"): Promise<TestDaemon> {
  td = await startTestDaemon({ policies: { "killer.ts": KILLER, "probe.ts": PROBE }, mode });
  return td;
}

async function judge(t: TestDaemon, command: string, shape: EventShape = {}) {
  const e = withFreshId(buildEvent({ tool: "Bash", kind: "exec", input: { command } }, shape));
  const res = await t.call("POST", "/v1/judge", e);
  return { event: e, status: res.status, body: res.body as VerdictResponse };
}

describe("a kill latches the session", () => {
  test("the next benign call is kill (sessionKilled), and no policy runs", async () => {
    const t = await daemon();
    expect((await judge(t, "rm -rf /srv/killme")).body.verdict).toBe("kill");
    const latchLine = t.audit().find((l) => l.kind === "session");
    expect(latchLine?.payload).toMatchObject({
      action: "latch",
      cause: "kill",
      root: TEST_SESSION,
    });
    (globalThis as Probe).__latchProbe = 0;
    const next = await judge(t, "ls");
    expect(next.status).toBe(200);
    expect(parseVerdict(next.body).ok).toBe(true);
    expect(next.body).toMatchObject({
      verdict: "kill",
      reason: SESSION_KILLED_REASON,
      policies: [],
      updated_input: null,
    });
    expect((globalThis as Probe).__latchProbe).toBe(0);
    const line = t.audit().find((l) => l.event_id === next.event.id);
    expect(line?.kind).toBe("judge");
    expect(line?.payload).toMatchObject({
      mapping: [SESSION_KILLED],
      returned: { verdict: "kill" },
      latched: { root: TEST_SESSION, cause: "kill" },
    });
    expect(line?.payload).not.toHaveProperty("decision");
  });

  test("/v1/session answers killed: true, and the prompt does not become the task", async () => {
    const t = await daemon();
    await judge(t, "rm -rf /srv/killme");
    const res = await t.call("POST", "/v1/session", sessionReport("prompt", { prompt: "go on" }));
    expect(res.body).toMatchObject({ ok: true, killed: true, task: "Fix the flaky test in auth/" });
  });

  test("a subagent of a latched root is killed", async () => {
    const t = await daemon();
    await judge(t, "rm -rf /srv/killme");
    const sub = await judge(t, "ls", { sessionId: SUB, parentId: TEST_SESSION, actor: "subagent" });
    expect(sub.body.verdict).toBe("kill");
  });

  test("a subagent's kill latches its root", async () => {
    const t = await daemon();
    const shape = { sessionId: SUB, parentId: TEST_SESSION, actor: "subagent" } as const;
    expect((await judge(t, "rm -rf /srv/killme", shape)).body.verdict).toBe("kill");
    expect((await judge(t, "ls")).body.verdict).toBe("kill");
  });

  test("other sessions are untouched", async () => {
    const t = await daemon();
    await judge(t, "rm -rf /srv/killme");
    expect((await judge(t, "ls", { sessionId: "sess_other" })).body.verdict).toBe("allow");
  });

  test("observe enforcement: the kill is returned as allow and latches nothing", async () => {
    const t = await daemon("observe");
    const killed = await judge(t, "rm -rf /srv/killme");
    expect(killed.body.verdict).toBe("allow");
    expect(killed.body.context_note).toStartWith("jev-cops would have: kill");
    expect((await judge(t, "ls")).body.context_note).toBeNull();
    expect(t.daemon.runtime.latch.count()).toBe(0);
  });
});

describe("only the admin socket clears a latch", () => {
  test("unlatch is 404 on the agent socket and leaves the latch", async () => {
    const t = await daemon();
    await judge(t, "rm -rf /srv/killme");
    const res = await t.call("POST", "/v1/session/unlatch", { session_id: TEST_SESSION });
    expect(res).toEqual({ status: 404, body: { error: "not found" } });
    expect((await judge(t, "ls")).body.verdict).toBe("kill");
  });

  test("unlatch on the admin socket clears the root and its subagents, audited", async () => {
    const t = await daemon();
    await judge(t, "rm -rf /srv/killme", { sessionId: SUB, parentId: TEST_SESSION });
    const res = await t.callAdmin("POST", "/v1/session/unlatch", { session_id: SUB, by: "alice" });
    expect(res).toEqual({
      status: 200,
      body: { ok: true, session_id: SUB, root_id: TEST_SESSION, cleared: 2 },
    });
    expect(t.audit().at(-1)).toMatchObject({
      kind: "session",
      session_id: SUB,
      payload: { action: "unlatch", by: "alice", root: TEST_SESSION, cleared: 2 },
    });
    expect((await judge(t, "ls")).body.verdict).toBe("allow");
    const again = await t.callAdmin("POST", "/v1/session/unlatch", { session_id: TEST_SESSION });
    expect(again).toEqual({ status: 404, body: { error: "session not latched" } });
  });

  test("a malformed unlatch is 400", async () => {
    const t = await daemon();
    const res = await t.callAdmin("POST", "/v1/session/unlatch", { session_id: "nope" });
    expect(res.status).toBe(400);
  });
});

describe("health", () => {
  test("reports how many sessions are latched, on both sockets", async () => {
    const t = await daemon();
    const before = await t.call("GET", "/v1/health");
    expect(before.body).toMatchObject({ latched_sessions: 0 });
    await judge(t, "rm -rf /srv/killme");
    await judge(t, "rm -rf /srv/killme", { sessionId: "sess_other" });
    expect((await t.callAdmin("GET", "/v1/health")).body).toMatchObject({ latched_sessions: 2 });
  });
});
