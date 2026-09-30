/**
 * `POST /v1/resolve` over the agent socket: precedents from a human's allow, and the
 * single-use hold tokens that keep anyone but the adapter that got the hold from
 * resolving it (T7/T8). The holds here are Pi's; a Claude Code hold never resolves
 * (`claude-code/holds.test.ts`).
 */
import { afterEach, describe, expect, test } from "bun:test";
import { parseVerdict, type VerdictResponse } from "@jev-cops/core";
import { buildEvent, type EventShape } from "../../../tests/fixtures/context/index.ts";
import { startTestDaemon, type TestDaemon, withFreshId } from "./testing/daemon.ts";
import { policyModule } from "./testing/policies.ts";
import { withHarness } from "./testing/session.ts";

const TASK = "Fix the flaky test in auth/";
/** Holds any delete; names the path so the precedent test can check narrowing. */
const GUARD = policyModule(
  "guard",
  1,
  "hold",
  `detail: () => 'HUMAN-ONLY-DETAIL', range: ["hold", "hold"],`,
).replace("when: () => true", 'when: (e) => e.kind === "fs.delete"');
const KILLER = policyModule("killer", 1, "kill").replace(
  "when: () => true",
  "when: (e) => e.paths.some((p) => p.includes('killme'))",
);

let td: TestDaemon | null = null;
afterEach(async () => {
  await td?.stop();
  td = null;
});

async function judge(command: string, shape: EventShape = {}) {
  const input = { command };
  const built = buildEvent({ tool: "Bash", kind: "exec", input }, { task: TASK, ...shape });
  const event = withHarness(withFreshId(built), "pi");
  const res = await (td as TestDaemon).call("POST", "/v1/judge", event);
  return { event, status: res.status, body: res.body as VerdictResponse & Record<string, unknown> };
}

describe("resolve and precedents", () => {
  test("resolve allow → precedent → the next matching event has lower risk", async () => {
    td = await startTestDaemon({ policies: { "guard.ts": GUARD } });
    const first = await judge("rm -rf /srv/data/cache");
    expect(first.body.verdict).toBe("hold");
    const resolved = await td.call("POST", "/v1/resolve", {
      event_id: first.event.id,
      decision: "allow",
      by: "alice",
      hold_token: first.body.hold_token,
    });
    expect(resolved.status).toBe(200);
    expect(resolved.body).toMatchObject({
      precedent: { scope: { pathPrefix: "/srv/data/cache" } },
    });
    const again = await judge("rm -rf /srv/data/cache");
    expect(again.body.risk).toBeLessThan(first.body.risk);
    expect(again.body.verdict).not.toBe("hold");
    const other = await judge("rm -rf /srv/elsewhere");
    expect(other.body.verdict).toBe("hold");
  });

  test("a request cannot supply the scope, and only held events resolve (T7/T8)", async () => {
    td = await startTestDaemon({ policies: { "guard.ts": GUARD } });
    const held = await judge("rm -rf /srv/data");
    const withScope = {
      event_id: held.event.id,
      decision: "allow",
      by: "a",
      hold_token: held.body.hold_token,
      scope: { pathPrefix: "/" },
    };
    expect((await td.call("POST", "/v1/resolve", withScope)).status).toBe(400);
    const allowed = await judge("ls");
    expect(allowed.body).not.toHaveProperty("hold_token");
    const res = await td.call("POST", "/v1/resolve", {
      event_id: allowed.event.id,
      decision: "allow",
      by: "a",
      hold_token: held.body.hold_token,
    });
    expect(res).toEqual({ status: 403, body: { error: "invalid hold token" } });
  });

  test("a precedent never lowers a kill", async () => {
    td = await startTestDaemon({ policies: { "guard.ts": GUARD, "killer.ts": KILLER } });
    const held = await judge("rm -rf /srv/data");
    await td.call("POST", "/v1/resolve", {
      event_id: held.event.id,
      decision: "allow",
      by: "a",
      hold_token: held.body.hold_token,
    });
    const { event, body } = await judge("rm -rf /srv/data/killme");
    expect(body.verdict).toBe("kill");
    const line = td.audit().find((l) => l.event_id === event.id && l.kind === "judge");
    expect(line?.payload).toMatchObject({ decision: { flags: { precedent: "ignored-kill" } } });
  });
});

describe("hold tokens (T7/T8: only the adapter that got the hold can resolve it)", () => {
  const T0 = 1_000_000;

  function resolve(eventId: string, token: unknown, decision = "allow") {
    const body = { event_id: eventId, decision, by: "mallory" };
    return (td as TestDaemon).call(
      "POST",
      "/v1/resolve",
      token === undefined ? body : { ...body, hold_token: token },
    );
  }

  function grants(): number {
    return (td as TestDaemon)
      .audit()
      .filter((l) => l.kind === "precedent" && l.payload.action === "grant").length;
  }

  test("a hold carries a fresh hold_token; the audit line keeps only a hash prefix", async () => {
    td = await startTestDaemon({ policies: { "guard.ts": GUARD } });
    const a = await judge("rm -rf /srv/a");
    const b = await judge("rm -rf /srv/b");
    expect(parseVerdict(a.body).ok).toBe(true);
    expect(a.body.hold_token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(b.body.hold_token).not.toBe(a.body.hold_token);
    const log = JSON.stringify(td.audit());
    expect(log).not.toContain(String(a.body.hold_token));
    const line = td.audit().find((l) => l.event_id === a.event.id && l.kind === "judge");
    expect(line?.payload).toMatchObject({
      returned: { verdict: "hold", hold_token_sha256: expect.stringMatching(/^[0-9a-f]{12}$/) },
    });
  });

  test("no token is minted when the harness will not ask a human (headless, observe)", async () => {
    td = await startTestDaemon({ policies: { "guard.ts": GUARD } });
    const headless = await judge("rm -rf /srv/a", { mode: "headless" });
    expect(headless.body.verdict).toBe("deny");
    expect(headless.body).not.toHaveProperty("hold_token");
    await td.stop();
    td = await startTestDaemon({ policies: { "guard.ts": GUARD }, mode: "observe" });
    const observed = await judge("rm -rf /srv/a");
    expect(observed.body.verdict).toBe("allow");
    expect(observed.body).not.toHaveProperty("hold_token");
  });

  test("resolve without a token: 403, an anomaly line, no precedent", async () => {
    td = await startTestDaemon({ policies: { "guard.ts": GUARD } });
    const held = await judge("rm -rf /srv/data");
    expect(await resolve(held.event.id, undefined)).toEqual({
      status: 403,
      body: { error: "invalid hold token" },
    });
    expect(td.audit().at(-1)).toMatchObject({
      kind: "anomaly",
      event_id: held.event.id,
      payload: { reason: "resolve-without-valid-token", why: "no-token" },
    });
    expect(grants()).toBe(0);
    expect((await judge("rm -rf /srv/data")).body.verdict).toBe("hold");
  });

  test("a wrong or malformed token is refused; the right one still works once", async () => {
    td = await startTestDaemon({ policies: { "guard.ts": GUARD } });
    const held = await judge("rm -rf /srv/data");
    const other = await judge("rm -rf /srv/other");
    expect((await resolve(held.event.id, other.body.hold_token)).status).toBe(403);
    expect((await resolve(held.event.id, "not-a-token")).status).toBe(403);
    expect((await resolve(held.event.id, 42)).status).toBe(400);
    expect(grants()).toBe(0);
    expect((await resolve(held.event.id, held.body.hold_token)).status).toBe(200);
    expect(grants()).toBe(1);
    const reused = await resolve(held.event.id, held.body.hold_token);
    expect(reused.status).toBe(403);
    expect(td.audit().at(-1)?.payload).toMatchObject({ why: "reused" });
    expect(grants()).toBe(1);
  });

  test("a token resolved with deny cannot be replayed as allow", async () => {
    td = await startTestDaemon({ policies: { "guard.ts": GUARD } });
    const held = await judge("rm -rf /srv/data");
    expect((await resolve(held.event.id, held.body.hold_token, "deny")).status).toBe(200);
    expect((await resolve(held.event.id, held.body.hold_token)).status).toBe(403);
    expect(grants()).toBe(0);
  });

  test("an expired token is refused (daemon.hold_token_ttl_ms)", async () => {
    let at = T0;
    td = await startTestDaemon({
      policies: { "guard.ts": GUARD },
      now: () => at,
      holdTokenTtlMs: 60_000,
    });
    const held = await judge("rm -rf /srv/data");
    at += 60_000;
    expect((await resolve(held.event.id, held.body.hold_token)).status).toBe(403);
    expect(td.audit().at(-1)?.payload).toMatchObject({ why: "expired" });
    expect(grants()).toBe(0);
  });
});
