/**
 * T7 — Precedent farming (spec §Threat model).
 *
 * Attack: Agent triggers many holds with slightly different args.
 * Required outcome: Precedent scope is proposed by the daemon, TTL-bound; repeated holds
 * raise the budget cost by 2x per repeat.
 *
 * Status: live. Core: the 2x budget cost. Daemon: the precedent scope is the one the daemon
 * proposed when it held the event (a resolve request carrying a scope is rejected), TTL is
 * the session with a 24 h cap, and holds farmed with varied arguments share one coarse key
 * so each repeat costs double end to end. An agent that talks to the socket directly
 * cannot grant a precedent without the hold's single-use token, and cannot reset its
 * budget (that route is on the admin socket only). On Claude Code no hold yields a
 * resolvable token at all (Claude Code's own prompt answers it; D-069 proposal), so no
 * precedent comes from a Claude Code hold. OpenShell JIT grants are M2; so is keeping the
 * agent off the socket altogether (an agent that posts its own judge request, naming a
 * harness that reports answers, receives that hold's token).
 */
import { describe, expect, test } from "bun:test";
import { readFileSync, statSync } from "node:fs";
import {
  charge,
  chargeHold,
  createBudget,
  DEFAULT_CONTEXT_CONFIG,
  type RiskBudget,
} from "@jevdict/core";
import {
  PRECEDENT_MAX_AGE_MS,
  PrecedentStore,
  proposeScope,
} from "../../packages/daemon/src/precedents.ts";
import {
  startTestDaemon,
  type TestDaemon,
  withFreshId,
} from "../../packages/daemon/src/testing/daemon.ts";
import { policyModule } from "../../packages/daemon/src/testing/policies.ts";
import { withHarness } from "../../packages/daemon/src/testing/session.ts";
import { bashPre, buildEvent, CTX_SESSION } from "../fixtures/context/index.ts";
import { pending } from "./pending.ts";

const CFG = DEFAULT_CONTEXT_CONFIG.budget;
const T0 = 1_000_000;

function holdOnce(budget: RiskBudget, key: string, risk: number): RiskBudget {
  const charged = charge(budget, risk, T0, CFG).budget;
  return chargeHold(charged, key, risk, T0, CFG).budget;
}

describe("T7 precedent farming: each repeated hold of one precedent key costs double", () => {
  test("costs 10, 20, 40, 80 for four holds of the same key at risk 0.5", () => {
    let budget = createBudget(CFG);
    const costs: number[] = [];
    for (let i = 0; i < 4; i++) {
      const next = holdOnce(budget, "exec:rm -rf /home/dev/", 0.5);
      costs.push(next.spent - budget.spent);
      budget = next;
    }
    expect(costs).toEqual([10, 20, 40, 80]);
  });

  test("farming exhausts the budget, which then holds every action", () => {
    let budget = createBudget(CFG);
    for (let i = 0; i < 4; i++) budget = holdOnce(budget, "net:post:api.example", 0.5);
    expect(charge(budget, 0, T0, CFG).holdAll).toBe(true);
  });

  test.todo("OpenShell JIT grants from a resolved hold are time-boxed (M2)", pending("M2"));
});

const HOLD_DELETES = policyModule("guard", 1, "hold").replace(
  "when: () => true",
  'when: (e) => e.kind === "fs.delete"',
);

describe("T7 precedent farming through the daemon", () => {
  test("repeated holds with varied args share one coarse key and cost double each time", async () => {
    const td = await startTestDaemon({ policies: { "guard.ts": HOLD_DELETES }, now: () => T0 });
    try {
      const spent: number[] = [];
      for (const n of [1, 2, 3]) {
        const e = withFreshId(
          buildEvent({ tool: "Bash", kind: "exec", input: { command: `rm -rf /srv/farm/${n}` } }),
        );
        const res = await td.call("POST", "/v1/judge", e);
        spent.push((res.body as { budget: { spent: number } }).budget.spent);
      }
      const costs = spent.map((s, i) => s - (spent[i - 1] ?? 0));
      expect(costs[0]).toBeGreaterThan(0);
      expect(costs).toEqual([costs[0] ?? 0, 2 * (costs[0] ?? 0), 4 * (costs[0] ?? 0)]);
    } finally {
      await td.stop();
    }
  });

  test("precedent scope is proposed by the daemon, never the agent", async () => {
    const td = await startTestDaemon({ policies: { "guard.ts": HOLD_DELETES } });
    try {
      const input = { command: "rm -rf /srv/data/tmp" };
      const e = withHarness(withFreshId(buildEvent({ tool: "Bash", kind: "exec", input })), "pi");
      const judged = await td.call("POST", "/v1/judge", e);
      const hold_token = (judged.body as { hold_token: string }).hold_token;
      const widened = {
        event_id: e.id,
        decision: "allow",
        by: "x",
        hold_token,
        scope: { pathPrefix: "/" },
      };
      expect((await td.call("POST", "/v1/resolve", widened)).status).toBe(400);
      const ok = await td.call("POST", "/v1/resolve", {
        event_id: e.id,
        decision: "allow",
        by: "x",
        hold_token,
      });
      const expected = proposeScope(await bashPre("rm -rf /srv/data/tmp"), e.session.task ?? null);
      expect((ok.body as { precedent: { scope: unknown } }).precedent.scope).toEqual(expected);
    } finally {
      await td.stop();
    }
  });

  test("precedents are TTL-bound and expire with the session", async () => {
    let at = T0;
    const store = new PrecedentStore(":memory:", { now: () => at });
    try {
      const n = await bashPre("rm -rf /srv/data/tmp");
      const grantOne = (id: string) => {
        store.recordHold({
          eventId: id,
          sessionId: CTX_SESSION,
          scope: proposeScope(n, null),
          policies: ["guard"],
        });
        store.grant(id, "x");
      };
      grantOne("evt_a");
      expect(store.active(CTX_SESSION)).toHaveLength(1);
      store.expireSession(CTX_SESSION);
      expect(store.active(CTX_SESSION)).toHaveLength(0);
      grantOne("evt_b");
      at += PRECEDENT_MAX_AGE_MS;
      expect(store.active(CTX_SESSION)).toHaveLength(0);
    } finally {
      store.close();
    }
  });
});

/** What an agent with a shell could do: talk to the agent socket itself, like curl would. */
function agentResolve(td: TestDaemon, eventId: string, token?: string) {
  const body = { event_id: eventId, decision: "allow", by: "the-agent" };
  return td.call(
    "POST",
    "/v1/resolve",
    token === undefined ? body : { ...body, hold_token: token },
  );
}

/** A hold the Pi adapter received (Pi reports the human's answer, so it can resolve). */
async function heldByAdapter(td: TestDaemon, command = "rm -rf /srv/farm/x") {
  const built = buildEvent({ tool: "Bash", kind: "exec", input: { command } });
  const e = withHarness(withFreshId(built), "pi");
  const res = await td.call("POST", "/v1/judge", e);
  const body = res.body as { verdict: string; hold_token: string };
  expect(body.verdict).toBe("hold");
  return { event: e, token: body.hold_token };
}

function grants(td: TestDaemon): number {
  return td.audit().filter((l) => l.kind === "precedent" && l.payload.action === "grant").length;
}

describe("T7: an agent that talks to the socket directly cannot grant a precedent", () => {
  test("resolve without the hold token: 403, an anomaly line, no precedent", async () => {
    const td = await startTestDaemon({ policies: { "guard.ts": HOLD_DELETES } });
    try {
      const { event } = await heldByAdapter(td);
      const res = await agentResolve(td, event.id);
      expect(res).toEqual({ status: 403, body: { error: "invalid hold token" } });
      expect(td.audit().at(-1)).toMatchObject({
        kind: "anomaly",
        event_id: event.id,
        payload: { reason: "resolve-without-valid-token" },
      });
      expect(grants(td)).toBe(0);
    } finally {
      await td.stop();
    }
  });

  test("the adapter's token grants once; replaying it is refused", async () => {
    const td = await startTestDaemon({ policies: { "guard.ts": HOLD_DELETES } });
    try {
      const { event, token } = await heldByAdapter(td);
      expect((await agentResolve(td, event.id, token)).status).toBe(200);
      expect(grants(td)).toBe(1);
      expect((await agentResolve(td, event.id, token)).status).toBe(403);
      expect(grants(td)).toBe(1);
    } finally {
      await td.stop();
    }
  });

  test("an expired token is refused", async () => {
    let at = T0;
    const td = await startTestDaemon({
      policies: { "guard.ts": HOLD_DELETES },
      now: () => at,
      holdTokenTtlMs: 600_000,
    });
    try {
      const { event, token } = await heldByAdapter(td);
      at += 600_000;
      expect((await agentResolve(td, event.id, token)).status).toBe(403);
      expect(grants(td)).toBe(0);
    } finally {
      await td.stop();
    }
  });

  test("canary: the raw token is nowhere in the audit file an agent can read", async () => {
    const td = await startTestDaemon({ policies: { "guard.ts": HOLD_DELETES } });
    try {
      const { event, token } = await heldByAdapter(td);
      await agentResolve(td, event.id, token);
      await agentResolve(td, event.id, token);
      const shown = await td.call("GET", `/v1/explain/${event.id}`);
      expect(readFileSync(td.config.audit.path, "utf8")).not.toContain(token);
      expect(JSON.stringify(shown.body)).not.toContain(token);
    } finally {
      await td.stop();
    }
  });

  test("budget reset: 404 on the agent socket, 200 on the admin socket (mode 0600)", async () => {
    const td = await startTestDaemon({ policies: { "guard.ts": HOLD_DELETES } });
    try {
      const { event } = await heldByAdapter(td);
      const reset = { session_id: event.session.id };
      expect((await td.call("POST", "/v1/budget/reset", reset)).status).toBe(404);
      const budget = await td.call("GET", `/v1/budget/${event.session.id}`);
      expect((budget.body as { spent: number }).spent).toBeGreaterThan(0);
      expect((await td.callAdmin("POST", "/v1/budget/reset", reset)).body).toMatchObject({
        spent: 0,
      });
      expect(statSync(td.config.daemon.adminSocket).mode & 0o777).toBe(0o600);
    } finally {
      await td.stop();
    }
  });

  test("Claude Code: a hold carries no resolvable token, so nothing can grant a precedent", async () => {
    const td = await startTestDaemon({ policies: { "guard.ts": HOLD_DELETES } });
    try {
      const input = { command: "rm -rf /srv/farm/cc" };
      const e = withFreshId(buildEvent({ tool: "Bash", kind: "exec", input }));
      expect(e.harness).toBe("claude-code");
      const res = await td.callWithHeaders("POST", "/v1/judge", e);
      expect(res.body).toMatchObject({ verdict: "hold" });
      expect(res.body).not.toHaveProperty("hold_token");
      const viewOnly = res.headers["x-jevdict-view-token"];
      expect((await agentResolve(td, e.id, viewOnly)).status).toBe(403);
      expect((await agentResolve(td, e.id)).status).toBe(403);
      expect(grants(td)).toBe(0);
    } finally {
      await td.stop();
    }
  });

  test.todo(
    "an agent that posts its own judge request gets that hold's token and can resolve it: closed when OpenShell keeps the agent's tools off the socket (M2)",
    pending("M2"),
  );
});
