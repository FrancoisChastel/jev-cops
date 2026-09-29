/**
 * T7 — Precedent farming (spec §Threat model).
 *
 * Attack: Agent triggers many holds with slightly different args.
 * Required outcome: Precedent scope is proposed by the daemon, TTL-bound; repeated holds
 * raise the budget cost by 2x per repeat.
 *
 * Status: live (core) for the 2x budget cost. Precedent scope and TTL land with the daemon's
 * precedent store (M0 step 8) and JIT grants (M2).
 */
import { describe, expect, test } from "bun:test";
import {
  charge,
  chargeHold,
  createBudget,
  DEFAULT_CONTEXT_CONFIG,
  type RiskBudget,
} from "@jevdict/core";
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

  test.todo(
    "precedent scope is proposed by the daemon, never the agent (M0 step 8)",
    pending("M0 step 8"),
  );
  test.todo(
    "precedents are TTL-bound and expire with the session (M0 step 8 / M2 JIT grants)",
    pending("M0 step 8 / M2 JIT grants"),
  );
});
