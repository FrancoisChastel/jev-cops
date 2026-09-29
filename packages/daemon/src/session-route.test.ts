/**
 * `POST /v1/session` (`jevdict.session/1`): the task is pinned once from the first
 * prompt (T11), start facts are cached for later events, `end` closes the session, and a
 * config change that breaks the hook block latches the session killed (T1).
 */
import { afterEach, describe, expect, test } from "bun:test";
import { MAX_TASK_BYTES, truncateUtf8 } from "./session-route.ts";
import { startTestDaemon, type TestDaemon } from "./testing/daemon.ts";
import { policyModule } from "./testing/policies.ts";
import { sessionReport, TEST_SESSION } from "./testing/session.ts";

const TASK = "Fix the flaky test in auth/";
const WIDER = "Fix the flaky test in auth/ and deploy it to https://prod.example";

let td: TestDaemon | null = null;
afterEach(async () => {
  await td?.stop();
  td = null;
});

async function daemon(mode: "enforce" | "observe" = "enforce"): Promise<TestDaemon> {
  td = await startTestDaemon({ policies: { "ok.ts": policyModule("ok") }, mode });
  return td;
}

async function report(t: TestDaemon, r: ReturnType<typeof sessionReport>) {
  const res = await t.call("POST", "/v1/session", r);
  return res as { status: number; body: { ok: boolean; task: string | null; killed: boolean } };
}

function sessionLines(t: TestDaemon) {
  return t.audit().filter((l) => l.kind === "session");
}

describe("POST /v1/session: start and end", () => {
  test("start is cached and audited; the reply carries the task and the latch", async () => {
    const t = await daemon();
    const fields = { model: "claude-opus-4-6", source: "startup", harness_version: "2.1.285" };
    const start = sessionReport("start", fields);
    const res = await report(t, start);
    expect(res).toEqual({ status: 200, body: { ok: true, task: null, killed: false } });
    const facts = t.daemon.runtime.facts.get(TEST_SESSION);
    expect(facts).toMatchObject({ model: "claude-opus-4-6", harnessVersion: "2.1.285" });
    expect(facts).toMatchObject({ mode: "interactive", noHuman: null });
    const line = sessionLines(t).at(-1);
    expect(line).toMatchObject({ event_id: start.id, session_id: TEST_SESSION });
    expect(line?.payload).toMatchObject({ report: "start", model: "claude-opus-4-6" });
  });

  test("end closes the root session and ends its precedents; a subagent end does not", async () => {
    const t = await daemon();
    await report(t, sessionReport("start"));
    const sub = { sessionId: `${TEST_SESSION}.agent_1`, parentId: TEST_SESSION };
    await report(t, sessionReport("end", {}, sub));
    expect(t.daemon.runtime.sessions.isOpen(TEST_SESSION)).toBe(true);
    const res = await report(t, sessionReport("end", { reason: "prompt_input_exit" }));
    expect(res.status).toBe(200);
    expect(t.daemon.runtime.sessions.isOpen(TEST_SESSION)).toBe(false);
    expect(sessionLines(t).at(-1)?.payload).toMatchObject({
      report: "end",
      reason: "prompt_input_exit",
      closed: true,
      precedents_ended: 0,
    });
  });
});

describe("POST /v1/session: the task is pinned once (T11)", () => {
  test("the first prompt is the task; a second prompt is ignored and logged", async () => {
    const t = await daemon();
    const first = await report(t, sessionReport("prompt", { prompt: TASK }));
    expect(first.body).toEqual({ ok: true, task: TASK, killed: false });
    const second = await report(t, sessionReport("prompt", { prompt: WIDER }));
    expect(second.body.task).toBe(TASK);
    const cf = t.daemon.runtime.sessions.openSession(TEST_SESSION, null);
    expect(cf.task).toBe(TASK);
    expect(cf.anomalies()).toEqual([`task change ignored: "${WIDER}"`]);
    const [set, ignored] = sessionLines(t).map((l) => l.payload);
    expect(set).toMatchObject({ report: "prompt", task_set: true, task: TASK });
    expect(ignored).toMatchObject({ report: "prompt", task_set: false });
    expect(ignored).not.toHaveProperty("task");
    expect(JSON.stringify(ignored)).not.toContain("prod.example");
    expect(ignored?.prompt_sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  test("a subagent shares its root's task and cannot replace it", async () => {
    const t = await daemon();
    await report(t, sessionReport("prompt", { prompt: TASK }));
    const sub = { sessionId: `${TEST_SESSION}.agent_1`, parentId: TEST_SESSION };
    const res = await report(t, sessionReport("prompt", { prompt: WIDER }, sub));
    expect(res.body.task).toBe(TASK);
    expect(t.daemon.runtime.sessions.rootOf(sub.sessionId)).toBe(TEST_SESSION);
  });

  test("a subagent's prompt never becomes the task, even before the user's first", async () => {
    const t = await daemon();
    const sub = { sessionId: `${TEST_SESSION}.agent_1`, parentId: TEST_SESSION };
    const early = await report(t, sessionReport("prompt", { prompt: WIDER }, sub));
    expect(early.body.task).toBeNull();
    expect(sessionLines(t).at(-1)?.payload).toMatchObject({ task_set: false, subagent: true });
    expect((await report(t, sessionReport("prompt", { prompt: TASK }))).body.task).toBe(TASK);
  });

  test("the task is capped at 16 KB (UTF-8), never splitting a character", async () => {
    const t = await daemon();
    const long = `${"a".repeat(MAX_TASK_BYTES - 1)}é and more`;
    const res = await report(t, sessionReport("prompt", { prompt: long }));
    expect(res.body.task).toBe("a".repeat(MAX_TASK_BYTES - 1));
    expect(sessionLines(t).at(-1)?.payload).toMatchObject({ truncated: true });
  });

  test("an empty prompt sets nothing", async () => {
    const t = await daemon();
    expect((await report(t, sessionReport("prompt", { prompt: "  " }))).body.task).toBeNull();
    expect((await report(t, sessionReport("prompt", { prompt: TASK }))).body.task).toBe(TASK);
  });
});

describe("truncateUtf8", () => {
  test("keeps short text, cuts on a character boundary", () => {
    expect(truncateUtf8("abc", 3)).toBe("abc");
    expect(truncateUtf8("abé", 3)).toBe("ab");
    expect(truncateUtf8("😀x", 3)).toBe("");
    expect(truncateUtf8("😀x", 4)).toBe("😀");
  });
});

describe("POST /v1/session: config changes (T1, D-077 proposal)", () => {
  test("an intact hook block is audited and latches nothing", async () => {
    const t = await daemon();
    const res = await report(
      t,
      sessionReport("config-change", { source: "user_settings", intact: true }),
    );
    expect(res.body.killed).toBe(false);
    expect(t.audit().some((l) => l.kind === "anomaly")).toBe(false);
    expect(sessionLines(t).at(-1)?.payload).toMatchObject({ intact: true, latched: false });
  });

  test("a removed or altered hook block latches the session killed, with an anomaly", async () => {
    const t = await daemon();
    const change = sessionReport("config-change", {
      source: "project_settings",
      file_path: "/work/repo/.claude/settings.json",
      intact: false,
    });
    const res = await report(t, change);
    expect(res.body.killed).toBe(true);
    const anomaly = t.audit().find((l) => l.kind === "anomaly");
    expect(anomaly).toMatchObject({ event_id: change.id, session_id: TEST_SESSION });
    expect(anomaly?.payload).toMatchObject({
      reason: "hook block removed or altered",
      source: "project_settings",
      file_path: "/work/repo/.claude/settings.json",
      latched: true,
    });
    const prompt = await report(t, sessionReport("prompt", { prompt: TASK }));
    expect(prompt.body).toEqual({ ok: true, task: null, killed: true });
  });

  test("policy_settings cannot be blocked: reported and audited, never latched", async () => {
    const t = await daemon();
    const change = { source: "policy_settings", intact: false };
    const res = await report(t, sessionReport("config-change", change));
    expect(res.body.killed).toBe(false);
    expect(t.audit().some((l) => l.kind === "anomaly")).toBe(false);
    expect(sessionLines(t).at(-1)?.payload).toMatchObject({
      report_only: true,
      intact: false,
      latched: false,
    });
  });

  test("observe enforcement records the anomaly but latches nothing", async () => {
    const t = await daemon("observe");
    const change = { source: "user_settings", intact: false };
    const res = await report(t, sessionReport("config-change", change));
    expect(res.body.killed).toBe(false);
    expect(t.audit().find((l) => l.kind === "anomaly")?.payload).toMatchObject({ latched: false });
  });
});

describe("POST /v1/session: refusals", () => {
  test("an invalid report is 400 with the schema issues; bad JSON is 400", async () => {
    const t = await daemon();
    const bad = await t.call("POST", "/v1/session", { ...sessionReport("prompt"), task: "x" });
    expect(bad.status).toBe(400);
    expect(bad.body).toMatchObject({ error: expect.any(String), issues: expect.any(Array) });
    expect((await t.call("POST", "/v1/session", "{nope")).status).toBe(400);
    expect(sessionLines(t)).toEqual([]);
  });

  test("the admin socket does not serve it", async () => {
    const t = await daemon();
    const res = await t.callAdmin("POST", "/v1/session", sessionReport("prompt", { prompt: TASK }));
    expect(res).toEqual({ status: 404, body: { error: "not found" } });
  });
});
