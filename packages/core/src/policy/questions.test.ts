import { describe, expect, test } from "bun:test";
import type { Question } from "../judge/types.ts";
import { resolvePolicyConfig } from "./config.ts";
import { createWhenTracker, evaluatePolicies } from "./evaluate.ts";
import { planQuestions, qualify, SCOPE_QUESTION } from "./questions.ts";
import type { PolicyContext, PolicyDefinition, PolicyEvent } from "./types.ts";

const E = {} as PolicyEvent;
const CTX = {} as PolicyContext;
const CFG = resolvePolicyConfig();
const TASK = "Fix the flaky test in auth/";

function q(name: string): Question {
  return { kind: "noul", name, text: `question ${name}` };
}

type Ask = (e: PolicyEvent, ctx: PolicyContext) => readonly Question[];

function asker(name: string, ask: Ask): PolicyDefinition {
  return { name, version: 1, owner: "t", when: () => true, ask, decide: () => "hold", reason: "r" };
}

function plan(
  policies: PolicyDefinition[],
  opts: { floor?: number; scopeUnsure?: boolean; task?: string | null } = {},
) {
  const matches = evaluatePolicies(policies, E, CTX, {
    tracker: createWhenTracker(10),
    sessionId: "s",
    config: { ...CFG, when: { ...CFG.when, budgetMs: 1_000 } },
  });
  return planQuestions({
    matches,
    e: E,
    ctx: CTX,
    floor: opts.floor ?? 0.5,
    scopeUnsure: opts.scopeUnsure ?? false,
    task: opts.task === undefined ? TASK : opts.task,
    config: CFG,
  });
}

describe("planQuestions", () => {
  test("qualifies names per policy and keeps each policy's own questions", () => {
    // Act
    const p = plan([asker("a", () => [q("x"), q("y")]), asker("b", () => [q("x")])]);
    // Assert
    expect(p.batch.map((x) => x.name)).toEqual(["a/x", "a/y", "b/x"]);
    expect(p.asked.get("a@1")?.map((x) => x.name)).toEqual(["x", "y"]);
    expect(qualify("a", "x")).toBe("a/x");
  });

  test("a policy whose questions do not fit in the 4-question batch is skipped whole", () => {
    const p = plan([
      asker("a", () => [q("1"), q("2"), q("3")]),
      asker("b", () => [q("4"), q("5")]),
    ]);
    expect(p.batch).toHaveLength(3);
    expect(p.skipped.get("b@1")).toBe("question limit 4 reached");
  });

  test("an ask that throws, over-asks or returns junk is skipped with the reason", () => {
    const p = plan([
      asker("threw", () => {
        throw new Error("no");
      }),
      asker("many", () => ["1", "2", "3", "4", "5"].map(q)),
      asker("junk", () => [{ nope: true }] as unknown as Question[]),
      asker("dup", () => [q("x"), q("x")]),
    ]);
    expect(p.batch).toEqual([]);
    expect(p.skipped.get("threw@1")).toBe("ask threw: no");
    expect(p.skipped.get("many@1")).toContain("at most 4");
    expect(p.skipped.get("junk@1")).toBe("ask did not return questions");
    expect(p.skipped.get("dup@1")).toContain("duplicate question name");
  });

  test("the scope question needs unsure scope, a task and a free slot; it goes last", () => {
    expect(plan([], { scopeUnsure: true }).batch).toEqual([
      { kind: "noul", name: SCOPE_QUESTION, text: `This action serves the task: ${TASK}` },
    ]);
    expect(plan([], { scopeUnsure: false }).scopeAsked).toBe(false);
    expect(plan([], { scopeUnsure: true, task: null }).scopeAsked).toBe(false);
    const full = plan([asker("a", () => ["1", "2", "3", "4"].map(q))], { scopeUnsure: true });
    expect(full.scopeAsked).toBe(false);
    const room = plan([asker("a", () => [q("1")])], { scopeUnsure: true });
    expect(room.batch.map((x) => x.name)).toEqual(["a/1", SCOPE_QUESTION]);
  });

  test("outside the band nothing is asked and ask is never called", () => {
    let called = false;
    const p = plan(
      [
        asker("a", () => {
          called = true;
          return [q("x")];
        }),
      ],
      { floor: 0.9, scopeUnsure: true },
    );
    expect(p).toMatchObject({ inBand: false, scopeAsked: false, batch: [] });
    expect(called).toBe(false);
    expect(p.skipped.get("a@1")).toContain("outside the uncertain band");
  });
});
