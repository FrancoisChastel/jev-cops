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
 * so each repeat costs double end to end. OpenShell JIT grants are M2.
 */
import { describe, expect, test } from "bun:test";
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
import { startTestDaemon, withFreshId } from "../../packages/daemon/src/testing/daemon.ts";
import { policyModule } from "../../packages/daemon/src/testing/policies.ts";
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
      const e = withFreshId(
        buildEvent({ tool: "Bash", kind: "exec", input: { command: "rm -rf /srv/data/tmp" } }),
      );
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
