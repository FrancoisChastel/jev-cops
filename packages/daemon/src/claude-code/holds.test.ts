/**
 * No precedents from Claude Code holds in M1 (D-069 proposal): Claude Code's own `ask`
 * prompt decides and the hook never learns the answer, so the daemon mints no resolvable
 * `hold_token` for a `claude-code` hold and `/v1/resolve` refuses it. The hook still needs
 * the T8 confirm view (raw + detail for the human-only `permissionDecisionReason`): it is
 * unlocked by a view-only token sent in the `x-jevdict-view-token` response header.
 */
import { afterEach, describe, expect, test } from "bun:test";
import type { PreEvent, VerdictResponse } from "@jevdict/core";
import { buildEvent, type EventShape } from "../../../../tests/fixtures/context/index.ts";
import { VIEW_TOKEN_HEADER } from "../holds.ts";
import { startTestDaemon, type TestDaemon, withFreshId } from "../testing/daemon.ts";
import { policyModule } from "../testing/policies.ts";
import { withHarness } from "../testing/session.ts";

const GUARD = policyModule(
  "guard",
  1,
  "hold",
  `detail: () => 'HUMAN-ONLY-DETAIL', range: ["hold", "hold"],`,
).replace("when: () => true", 'when: (e) => e.kind === "fs.delete"');
const TOKEN = /^[A-Za-z0-9_-]{43}$/;

let td: TestDaemon | null = null;
afterEach(async () => {
  await td?.stop();
  td = null;
});

async function daemon(mode: "enforce" | "observe" = "enforce"): Promise<TestDaemon> {
  td = await startTestDaemon({ policies: { "guard.ts": GUARD }, mode });
  return td;
}

function event(shape: EventShape = {}): PreEvent {
  const input = { command: "rm -rf /srv/data", description: "harmless" };
  return withFreshId(buildEvent({ tool: "Bash", kind: "exec", input }, shape) as PreEvent);
}

async function judge(t: TestDaemon, e: PreEvent) {
  const res = await t.callWithHeaders("POST", "/v1/judge", e);
  return { ...res, body: res.body as VerdictResponse & Record<string, unknown> };
}

const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

describe("a Claude Code hold", () => {
  test("has no hold_token; a view-only token comes in the response header", async () => {
    const t = await daemon();
    const e = event();
    const { body, headers } = await judge(t, e);
    expect(body.verdict).toBe("hold");
    expect(body).not.toHaveProperty("hold_token");
    expect(headers[VIEW_TOKEN_HEADER]).toMatch(TOKEN);
    const line = t.audit().find((l) => l.event_id === e.id);
    expect(line?.payload.returned).toMatchObject({
      verdict: "hold",
      view_token_sha256: expect.stringMatching(/^[0-9a-f]{12}$/),
    });
    expect(line?.payload.returned).not.toHaveProperty("hold_token_sha256");
    expect(JSON.stringify(t.audit())).not.toContain(headers[VIEW_TOKEN_HEADER] ?? "none");
  });

  test("the view token unlocks the T8 confirm view, and nothing else does", async () => {
    const t = await daemon();
    const e = event();
    const token = (await judge(t, e)).headers[VIEW_TOKEN_HEADER] ?? "";
    const view = await t.call("GET", `/v1/explain/${e.id}`, undefined, bearer(token));
    expect(view).toEqual({
      status: 200,
      body: {
        event_id: e.id,
        verdict: "hold",
        reason: "test policy guard",
        raw: "rm -rf /srv/data",
        detail: expect.stringContaining("HUMAN-ONLY-DETAIL"),
      },
    });
    const wrong = await t.call("GET", `/v1/explain/${e.id}`, undefined, bearer("x".repeat(43)));
    expect(wrong).toEqual({ status: 403, body: { error: "invalid hold token" } });
    const none = await t.call("GET", `/v1/explain/${e.id}`);
    expect(none.status).toBe(403);
    expect(t.audit().at(-1)).toMatchObject({
      kind: "anomaly",
      payload: { reason: "explain-without-valid-token" },
    });
  });

  test("/v1/resolve refuses it with 403 and an anomaly; no precedent is granted", async () => {
    const t = await daemon();
    const e = event();
    const token = (await judge(t, e)).headers[VIEW_TOKEN_HEADER] ?? "";
    for (const hold_token of [token, undefined]) {
      const res = await t.call("POST", "/v1/resolve", {
        event_id: e.id,
        decision: "allow",
        by: "agent",
        ...(hold_token === undefined ? {} : { hold_token }),
      });
      expect(res).toEqual({ status: 403, body: { error: "invalid hold token" } });
    }
    const refused = t.audit().filter((l) => l.payload.reason === "resolve-without-valid-token");
    expect(refused).toHaveLength(2);
    expect(t.audit().some((l) => l.kind === "precedent")).toBe(false);
    expect(t.daemon.runtime.precedents.pendingHold(e.id)).toBeNull();
    expect((await judge(t, event())).body.verdict).toBe("hold");
  });

  test("no view token when the hold is not shown to a human", async () => {
    const headless = await daemon();
    const denied = await judge(headless, event({ mode: "headless" }));
    expect(denied.body.verdict).toBe("deny");
    expect(denied.headers).not.toHaveProperty(VIEW_TOKEN_HEADER);
    await headless.stop();
    td = null;
    const observing = await daemon("observe");
    const allowed = await judge(observing, event());
    expect(allowed.body.verdict).toBe("allow");
    expect(allowed.headers).not.toHaveProperty(VIEW_TOKEN_HEADER);
  });
});

describe("the Pi path is unchanged", () => {
  test("a Pi hold mints a resolvable hold_token and no view header", async () => {
    const t = await daemon();
    const e = withHarness(event(), "pi");
    const { body, headers } = await judge(t, e);
    expect(body.hold_token).toMatch(TOKEN);
    expect(headers).not.toHaveProperty(VIEW_TOKEN_HEADER);
    const hold_token = body.hold_token as string;
    const view = await t.call("GET", `/v1/explain/${e.id}`, undefined, bearer(hold_token));
    expect(view.status).toBe(200);
    const res = await t.call("POST", "/v1/resolve", {
      event_id: e.id,
      decision: "allow",
      by: "alice",
      hold_token,
    });
    expect(res.status).toBe(200);
  });
});
