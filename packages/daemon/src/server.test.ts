import { afterEach, describe, expect, test } from "bun:test";
import { statSync } from "node:fs";
import { createMockJudge, parseVerdict, type VerdictResponse } from "@jev-cops/core";
import { buildEvent, type EventShape } from "../../../tests/fixtures/context/index.ts";
import { createRuntime } from "./daemon.ts";
import { SILENT_LOGGER } from "./log.ts";
import { listen } from "./server.ts";
import { startTestDaemon, type TestDaemon, testConfig, withFreshId } from "./testing/daemon.ts";
import { policyModule } from "./testing/policies.ts";

const TASK = "Fix the flaky test in auth/";
const DETAIL = "detail: () => 'HUMAN-ONLY-DETAIL',";
/** Holds any delete; names the path so the precedent test can check narrowing. */
const GUARD = policyModule("guard", 1, "hold", `${DETAIL} range: ["hold", "hold"],`).replace(
  "when: () => true",
  'when: (e) => e.kind === "fs.delete"',
);

let td: TestDaemon | null = null;
afterEach(async () => {
  await td?.stop();
  td = null;
});

function bash(command: string, shape: EventShape = {}) {
  const e = buildEvent(
    { tool: "Bash", kind: "exec", input: { command } },
    { task: TASK, ...shape },
  );
  return withFreshId(e);
}

async function judge(command: string, shape: EventShape = {}) {
  const event = bash(command, shape);
  const res = await (td as TestDaemon).call("POST", "/v1/judge", event);
  return { event, status: res.status, body: res.body as VerdictResponse & Record<string, unknown> };
}

describe("POST /v1/judge over the Unix socket", () => {
  test("happy path: a valid jev-cops.verdict/1 response", async () => {
    td = await startTestDaemon({ policies: { "ok.ts": policyModule("ok") } });
    const { event, status, body } = await judge("ls");
    expect(status).toBe(200);
    expect(parseVerdict(body).ok).toBe(true);
    expect(body).toMatchObject({ event_id: event.id, verdict: "allow" });
  });

  test("an invalid event is 400 with the schema issues", async () => {
    td = await startTestDaemon({ policies: { "ok.ts": policyModule("ok") } });
    const res = await td.call("POST", "/v1/judge", { schema: "jev-cops.event/1", phase: "pre" });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: expect.any(String), issues: expect.any(Array) });
    expect((await td.call("POST", "/v1/judge", "{not json")).status).toBe(400);
  });

  test("a post event on /v1/judge is 400", async () => {
    td = await startTestDaemon({ policies: { "ok.ts": policyModule("ok") } });
    const post = buildEvent({ tool: "Bash", kind: "exec", input: { command: "ls" } }, {}, {});
    expect((await td.call("POST", "/v1/judge", post)).status).toBe(400);
  });

  test("detail is never in the response", async () => {
    td = await startTestDaemon({ policies: { "guard.ts": GUARD } });
    const { body } = await judge("rm -rf /srv/data");
    expect(body.verdict).toBe("hold");
    expect(body).not.toHaveProperty("detail");
    expect(JSON.stringify(body)).not.toContain("HUMAN-ONLY-DETAIL");
  });

  test("D-008: headless hold is returned as deny and traced", async () => {
    td = await startTestDaemon({ policies: { "guard.ts": GUARD } });
    const { event, body } = await judge("rm -rf /srv/data", { mode: "headless" });
    expect(body.verdict).toBe("deny");
    const line = td.audit().find((l) => l.event_id === event.id);
    expect(line?.payload).toMatchObject({
      decision: { verdict: "hold" },
      returned: { verdict: "deny" },
      mapping: ["headlessHoldDenied"],
    });
  });

  test("observe mode returns allow and logs the real verdict", async () => {
    td = await startTestDaemon({
      policies: { "no.ts": policyModule("no", 1, "deny") },
      mode: "observe",
    });
    const { event, body } = await judge("ls");
    expect(body.verdict).toBe("allow");
    expect(body.context_note).toStartWith("jev-cops would have: deny — ");
    const line = td.audit().find((l) => l.event_id === event.id);
    expect(line?.payload).toMatchObject({ decision: { verdict: "deny" }, enforcement: "observe" });
  });

  test("an internal error is 500 and an anomaly line (the adapter fails closed)", async () => {
    td = await startTestDaemon({ policies: { "ok.ts": policyModule("ok") } });
    td.daemon.runtime.sessions.close();
    const { status, body } = await judge("ls");
    expect(status).toBe(500);
    expect(body).toEqual({ error: "internal error" } as unknown as typeof body);
    expect(td.audit().at(-1)).toMatchObject({ kind: "anomaly", payload: { route: "/v1/judge" } });
  });
});

describe("POST /v1/observe", () => {
  test("204, recorded without the output head", async () => {
    td = await startTestDaemon({ policies: { "ok.ts": policyModule("ok") } });
    const post = withFreshId(
      buildEvent(
        { tool: "Bash", kind: "exec", input: { command: "cat x" } },
        {},
        { stdout: "SECRET-HEAD-42" },
      ),
    );
    const res = await td.call("POST", "/v1/observe", post);
    expect(res.status).toBe(204);
    const line = td.audit().find((l) => l.event_id === post.id);
    expect(line?.kind).toBe("observe");
    expect(JSON.stringify(line)).not.toContain("SECRET-HEAD-42");
  });
});

describe("budget", () => {
  test("read on the agent socket, reset on the admin socket; unknown sessions are 404", async () => {
    td = await startTestDaemon({ policies: { "guard.ts": GUARD } });
    const { event } = await judge("rm -rf /srv/data");
    const sid = event.session.id;
    const before = await td.call("GET", `/v1/budget/${sid}`);
    expect((before.body as { spent: number }).spent).toBeGreaterThan(0);
    const reset = await td.callAdmin("POST", "/v1/budget/reset", { session_id: sid });
    expect(reset.body).toMatchObject({ session_id: sid, spent: 0 });
    expect((await td.call("GET", "/v1/budget/sess_nobody")).status).toBe(404);
    const nobody = await td.callAdmin("POST", "/v1/budget/reset", { session_id: "sess_nobody" });
    expect(nobody.status).toBe(404);
  });
});

describe("admin socket (H1: human-only routes are not on the socket the sandbox mounts)", () => {
  test("budget reset is 404 on the agent socket and leaves the budget alone", async () => {
    td = await startTestDaemon({ policies: { "guard.ts": GUARD } });
    const { event } = await judge("rm -rf /srv/data");
    const sid = event.session.id;
    const spent = async () =>
      ((await (td as TestDaemon).call("GET", `/v1/budget/${sid}`)).body as { spent: number }).spent;
    const before = await spent();
    expect(before).toBeGreaterThan(0);
    const res = await td.call("POST", "/v1/budget/reset", { session_id: sid });
    expect(res).toEqual({ status: 404, body: { error: "not found" } });
    expect(await spent()).toBe(before);
    expect(td.audit().some((l) => l.payload.action === "budget-reset")).toBe(false);
  });

  test("the admin socket is mode 0600 in a 0700 directory", async () => {
    td = await startTestDaemon({ policies: { "ok.ts": policyModule("ok") } });
    const admin = td.config.daemon.adminSocket;
    expect(statSync(admin).mode & 0o777).toBe(0o600);
    expect(statSync(td.config.daemon.socket).mode & 0o777).toBe(0o600);
    expect(td.daemon.listening.adminSocket).toBe(admin);
  });

  test("the admin socket serves health, explain and budget reset, nothing agent-facing", async () => {
    td = await startTestDaemon({ policies: { "guard.ts": GUARD } });
    const { event } = await judge("rm -rf /srv/data");
    expect((await td.callAdmin("GET", "/v1/health")).status).toBe(200);
    expect((await td.callAdmin("GET", `/v1/explain/${event.id}`)).status).toBe(200);
    for (const path of ["/v1/judge", "/v1/observe", "/v1/resolve"]) {
      expect((await td.callAdmin("POST", path, bash("ls"))).status).toBe(404);
    }
    expect((await td.callAdmin("GET", `/v1/budget/${event.session.id}`)).status).toBe(404);
  });

  test("health on either socket reports both sockets", async () => {
    td = await startTestDaemon({ policies: { "ok.ts": policyModule("ok") } });
    const sockets = { agent: td.config.daemon.socket, admin: td.config.daemon.adminSocket };
    expect((await td.call("GET", "/v1/health")).body).toMatchObject({ sockets });
    expect((await td.callAdmin("GET", "/v1/health")).body).toMatchObject({ sockets });
  });

  test("the admin socket must be a different, short enough path", async () => {
    td = await startTestDaemon({ policies: { "ok.ts": policyModule("ok") } });
    const rt = td.daemon.runtime;
    const socket = `${td.dir}/x.sock`;
    await expect(listen(rt, { socket, adminSocket: socket, http: null })).rejects.toThrow(
      /must differ/,
    );
    const long = `${td.dir}/${"x".repeat(120)}.sock`;
    await expect(listen(rt, { socket, adminSocket: long, http: null })).rejects.toThrow(
      /socket path is \d+ bytes/,
    );
  });
});

describe("health and policy reload", () => {
  test("health reports policies, judge, enforcement", async () => {
    td = await startTestDaemon({ policies: { "ok.ts": policyModule("ok") }, mode: "observe" });
    const res = await td.call("GET", "/v1/health");
    expect(res.body).toMatchObject({
      ok: true,
      policies: [{ name: "ok", version: 1, degraded: false }],
      judge: "disabled",
      enforcement: "observe",
    });
  });

  test("a new policy file shows up in /v1/health", async () => {
    td = await startTestDaemon({ policies: { "ok.ts": policyModule("ok") } });
    td.writePolicy("more.ts", policyModule("more"));
    const deadline = Date.now() + 3_000;
    let count = 1;
    while (count < 2 && Date.now() < deadline) {
      await Bun.sleep(25);
      count = ((await td.call("GET", "/v1/health")).body as { policies: unknown[] }).policies
        .length;
    }
    expect(count).toBe(2);
    expect(td.audit().some((l) => l.payload.event === "policy-reload")).toBe(true);
  });
});

describe("binding", () => {
  test("serves loopback HTTP when configured", async () => {
    td = await startTestDaemon({
      policies: { "ok.ts": policyModule("ok") },
      http: { host: "127.0.0.1", port: 0 },
    });
    const url = td.daemon.listening.httpUrl ?? "";
    expect(url).toStartWith("http://127.0.0.1:");
    expect((await fetch(`${url}/v1/health`)).status).toBe(200);
  });

  test("refuses to bind a non-loopback address (T13)", async () => {
    td = await startTestDaemon({ policies: { "ok.ts": policyModule("ok") } });
    const cfg = testConfig(`${td.dir}/other`, { policies: {} });
    const rt = td.daemon.runtime;
    const { socket, adminSocket } = cfg.daemon;
    await expect(
      listen(rt, { socket, adminSocket, http: { host: "0.0.0.0", port: 0 } }),
    ).rejects.toThrow(/non-loopback/);
  });

  test("a socket path too long for sun_path is refused, not silently truncated", async () => {
    td = await startTestDaemon({ policies: { "ok.ts": policyModule("ok") } });
    const long = `${td.dir}/${"x".repeat(120)}.sock`;
    const adminSocket = `${td.dir}/a2.sock`;
    await expect(
      listen(td.daemon.runtime, { socket: long, adminSocket, http: null }),
    ).rejects.toThrow(/socket path is \d+ bytes/);
  });

  test("a second daemon on a live socket refuses to start", async () => {
    td = await startTestDaemon({ policies: { "ok.ts": policyModule("ok") } });
    const rt = await createRuntime(
      {
        ...td.config,
        audit: { ...td.config.audit, path: `${td.dir}/a2.jsonl`, forward: null },
        store: { path: `${td.dir}/s2.sqlite` },
      },
      { log: SILENT_LOGGER },
    );
    await expect(listen(rt)).rejects.toThrow(/already running/);
    await rt.close();
  });
});

describe("judge deadline (T3)", () => {
  test("a judge that sleeps 15 s gets a 504 'judge timeout' well before 15 s", async () => {
    const asks = policyModule(
      "asks",
      1,
      "allow",
      'ask: () => [{ kind: "noul", name: "safe", text: "Is this safe?" }],',
    );
    td = await startTestDaemon({
      policies: { "asks.ts": asks },
      judge: createMockJudge(
        { "asks/safe": { kind: "noul", p: 1, confidence: 1 } },
        { delayMs: 15_000 },
      ),
      deadlineMs: 200,
      judgeTimeoutMs: 1_000,
      policy: { ask: { min: 0 } },
    });
    const started = performance.now();
    const { event, status, body } = await judge("ls");
    const elapsed = performance.now() - started;
    expect(status).toBe(504);
    expect(body).toEqual({ error: "judge timeout" } as unknown as typeof body);
    expect(elapsed).toBeLessThan(1_000);
    expect(td.audit().some((l) => l.kind === "anomaly" && l.event_id === event.id)).toBe(true);
  });
});
