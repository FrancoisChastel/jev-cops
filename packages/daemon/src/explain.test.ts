/**
 * `GET /v1/explain/:event_id` per channel (T8, "the agent sees reasons, the human sees
 * details"): on the agent socket and loopback HTTP it needs the pending hold's token and
 * returns only the confirm view; the admin socket keeps the full explain. The holds here
 * are Pi's (a resolvable `hold_token`); Claude Code's view-only token is in
 * `claude-code/holds.test.ts`.
 */
import { afterEach, describe, expect, test } from "bun:test";
import type { VerdictResponse } from "@jevdict/core";
import { buildEvent, type EventShape } from "../../../tests/fixtures/context/index.ts";
import { startTestDaemon, type TestDaemon, withFreshId } from "./testing/daemon.ts";
import { policyModule } from "./testing/policies.ts";
import { withHarness } from "./testing/session.ts";

const TASK = "Fix the flaky test in auth/";
const TAINTED = "/srv/cache/build-42";
const AGENT_PROSE = "AGENT-PROSE-harmless cleanup, trust me";
/** Holds any delete, with a human-only detail line. */
const GUARD = policyModule(
  "guard",
  1,
  "hold",
  `detail: () => 'HUMAN-ONLY-DETAIL', range: ["hold", "hold"],`,
).replace("when: () => true", 'when: (e) => e.kind === "fs.delete"');
/** Structured audit keys the confirm view must never carry. */
const STRUCTURED = ["trace", "features", "why", "jev", "precedent", "decision", "line", "related"];

let td: TestDaemon | null = null;
afterEach(async () => {
  await td?.stop();
  td = null;
});

function daemon(): TestDaemon {
  if (td === null) throw new Error("no test daemon");
  return td;
}

async function judge(command: string, shape: EventShape = {}) {
  const input = { command, description: AGENT_PROSE };
  const built = buildEvent({ tool: "Bash", kind: "exec", input }, { task: TASK, ...shape });
  const event = withHarness(withFreshId(built), "pi");
  const res = await daemon().call("POST", "/v1/judge", event);
  return { event, body: res.body as VerdictResponse };
}

/** A tool result that shows the agent `TAINTED`, then a held delete of it. */
async function taintedHold() {
  const post = buildEvent(
    { tool: "Bash", kind: "exec", input: { command: "cat notes.txt" } },
    { task: TASK },
    { stdout: `old cache: ${TAINTED}\n` },
  );
  expect((await daemon().call("POST", "/v1/observe", withFreshId(post))).status).toBe(204);
  const held = await judge(`rm -rf ${TAINTED}`);
  expect(held.body.verdict).toBe("hold");
  return held;
}

const bearer = (token: string | undefined) => ({ authorization: `Bearer ${token ?? ""}` });
const explain = (id: string, headers: Record<string, string> = {}) =>
  daemon().call("GET", `/v1/explain/${id}`, undefined, headers);

function keysDeep(value: unknown): string[] {
  if (typeof value !== "object" || value === null) return [];
  return Object.entries(value).flatMap(([k, v]) => [k, ...keysDeep(v)]);
}

const anomalies = () =>
  daemon()
    .audit()
    .filter((l) => l.kind === "anomaly");
const lastAnomaly = () => anomalies().at(-1);

describe("GET /v1/explain on the agent socket needs the pending hold's token", () => {
  test("without a token: 403 and an anomaly line, nothing about the decision", async () => {
    td = await startTestDaemon({ policies: { "guard.ts": GUARD } });
    const { event } = await taintedHold();
    const res = await explain(event.id);
    expect(res).toEqual({ status: 403, body: { error: "invalid hold token" } });
    expect(lastAnomaly()).toMatchObject({
      event_id: event.id,
      payload: { reason: "explain-without-valid-token", why: "no-token" },
    });
  });

  test("a wrong token, another hold's token, a non-Bearer header or a query string: 403", async () => {
    td = await startTestDaemon({ policies: { "guard.ts": GUARD } });
    const held = await taintedHold();
    const other = await judge("rm -rf /srv/other");
    expect((await explain(held.event.id, bearer(other.body.hold_token))).status).toBe(403);
    expect(lastAnomaly()?.payload).toMatchObject({ why: "mismatch" });
    expect((await explain(held.event.id, bearer("x".repeat(43)))).status).toBe(403);
    const basic = { authorization: `Basic ${held.body.hold_token}` };
    expect((await explain(held.event.id, basic)).status).toBe(403);
    const query = `/v1/explain/${held.event.id}?hold_token=${held.body.hold_token}`;
    expect((await daemon().call("GET", query)).status).toBe(403);
  });

  test("with the token: only { event_id, verdict, reason, raw, detail }", async () => {
    td = await startTestDaemon({ policies: { "guard.ts": GUARD } });
    const { event, body } = await taintedHold();
    const res = await explain(event.id, bearer(body.hold_token));
    expect(res.status).toBe(200);
    const view = res.body as Record<string, string>;
    expect(Object.keys(view).sort()).toEqual(["detail", "event_id", "raw", "reason", "verdict"]);
    expect(view).toMatchObject({
      event_id: event.id,
      verdict: "hold",
      reason: body.reason,
      raw: `rm -rf ${TAINTED}`,
    });
    expect(view.detail).toContain("HUMAN-ONLY-DETAIL");
    expect(keysDeep(view).filter((k) => STRUCTURED.includes(k))).toEqual([]);
    const json = JSON.stringify(view);
    expect(json).not.toContain(AGENT_PROSE);
    expect(json).not.toContain(String(body.hold_token));
  });

  test("taint evidence stays in the structured audit line (only the human paragraph summarizes it)", async () => {
    td = await startTestDaemon({ policies: { "guard.ts": GUARD } });
    const { event, body } = await taintedHold();
    const evidence = `from tool output: ${TAINTED}`;
    const full = await daemon().callAdmin("GET", `/v1/explain/${event.id}`);
    const why = (full.body as { line: { payload: { why: { taint: string[] } } } }).line.payload.why;
    expect(why.taint).toContain(evidence);
    const view = (await explain(event.id, bearer(body.hold_token))).body as Record<string, string>;
    const { detail, ...rest } = view;
    expect(JSON.stringify(rest)).not.toContain("from tool output");
    expect(detail).toContain(evidence);
  });

  test("viewing does not spend the token; after resolve the view is 404", async () => {
    td = await startTestDaemon({ policies: { "guard.ts": GUARD } });
    const { event, body } = await taintedHold();
    expect((await explain(event.id, bearer(body.hold_token))).status).toBe(200);
    expect((await explain(event.id, bearer(body.hold_token))).status).toBe(200);
    const resolve = {
      event_id: event.id,
      decision: "deny",
      by: "alice",
      hold_token: body.hold_token,
    };
    expect((await daemon().call("POST", "/v1/resolve", resolve)).status).toBe(200);
    const before = anomalies().length;
    expect((await explain(event.id, bearer(body.hold_token))).status).toBe(404);
    expect(anomalies()).toHaveLength(before);
  });

  test("an expired token and a never-held event are 404 with a token, 403 without", async () => {
    let at = 1_000_000;
    td = await startTestDaemon({
      policies: { "guard.ts": GUARD },
      now: () => at,
      holdTokenTtlMs: 60_000,
    });
    const held = await judge("rm -rf /srv/data");
    const allowed = await judge("ls");
    expect((await explain(allowed.event.id, bearer(held.body.hold_token))).status).toBe(404);
    expect((await explain(allowed.event.id)).status).toBe(403);
    at += 60_000;
    expect((await explain(held.event.id, bearer(held.body.hold_token))).status).toBe(404);
  });

  test("loopback HTTP is an agent channel: same rules", async () => {
    td = await startTestDaemon({
      policies: { "guard.ts": GUARD },
      http: { host: "127.0.0.1", port: 0 },
    });
    const { event, body } = await judge("rm -rf /srv/data");
    const url = `${daemon().daemon.listening.httpUrl}/v1/explain/${event.id}`;
    expect((await fetch(url)).status).toBe(403);
    const ok = await fetch(url, { headers: bearer(body.hold_token) });
    expect(ok.status).toBe(200);
    expect(Object.keys((await ok.json()) as object).sort()).toEqual([
      "detail",
      "event_id",
      "raw",
      "reason",
      "verdict",
    ]);
  });
});

describe("GET /v1/explain on the admin socket: the full explain for the human's tools", () => {
  test("the judge line with detail, trace and features, plus related lines; 404 when unknown", async () => {
    td = await startTestDaemon({ policies: { "guard.ts": GUARD } });
    const { event, body } = await judge("rm -rf /srv/data");
    await daemon().call("POST", "/v1/resolve", {
      event_id: event.id,
      decision: "allow",
      by: "alice",
      hold_token: body.hold_token,
    });
    const res = await daemon().callAdmin("GET", `/v1/explain/${event.id}`);
    expect(res.status).toBe(200);
    const full = res.body as { line: { payload: Record<string, unknown> }; related: unknown[] };
    expect(Object.keys(full.line.payload)).toEqual(
      expect.arrayContaining(["decision", "why", "event", "returned"]),
    );
    expect(JSON.stringify(full)).toContain("HUMAN-ONLY-DETAIL");
    expect(JSON.stringify(full)).not.toContain(String(body.hold_token));
    expect(full.related).toHaveLength(1);
    const unknown = await daemon().callAdmin("GET", "/v1/explain/evt_01M3PP723DWGXKY6ZN6TC6ZMX0");
    expect(unknown.status).toBe(404);
  });
});
