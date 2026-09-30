import { describe, expect, test } from "bun:test";
import type { HookRun } from "./hook-run.ts";
import { combine, decisionOf, type PreDecision } from "./pre-decision.ts";

/**
 * The fake Claude Code's PreToolUse oracle against the hooks reference
 * (https://code.claude.com/docs/en/hooks, re-read 2026-09-30 from its raw markdown, and
 * https://code.claude.com/docs/en/hooks-guide). Every e2e verdict on Claude Code goes
 * through this oracle, so a permissive mistake here would hide a fail-open in the hook.
 */

function run(o: Partial<HookRun> = {}): HookRun {
  return { exitCode: 0, stdout: "", stderr: "", json: null, hookError: null, ms: 10, ...o };
}

function pre(fields: Record<string, unknown>, top: Record<string, unknown> = {}) {
  return { ...top, hookSpecificOutput: { hookEventName: "PreToolUse", ...fields } };
}

// hooks#pretooluse-decision-control: "`"allow"` skips the permission prompt … `"deny"`
// prevents the tool call. `"ask"` prompts the user to confirm. `"defer"` exits gracefully";
// `permissionDecisionReason`: "For `"ask"`, shown to the user but not Claude. For `"deny"`,
// shown to Claude. For `"allow"` and `"defer"`, written to the debug log only".
describe("one handler: the JSON decision (exit 0)", () => {
  test("no output decides nothing: the normal permission flow applies", () => {
    expect(decisionOf(run())).toMatchObject({ outcome: "proceed", reason: null, hookErrors: [] });
  });

  test.each([
    ["allow", null],
    ["deny", "no"],
    ["ask", "no"],
    ["defer", null],
  ] as const)("%s: the reason reaches Claude or the user only for deny/ask (%p)", (d, reason) => {
    const json = pre({ permissionDecision: d, permissionDecisionReason: "no" });
    expect(decisionOf(run({ json }))).toMatchObject({ outcome: d, reason });
  });

  test("updatedInput replaces the input, additionalContext goes to Claude", () => {
    const json = pre({
      permissionDecision: "allow",
      updatedInput: { a: 1 },
      additionalContext: "c",
    });
    expect(decisionOf(run({ json }))).toMatchObject({ updatedInput: { a: 1 }, context: ["c"] });
  });

  test("defer ignores updatedInput (hooks#pretooluse-decision-control: 'For \"defer\", ignored')", () => {
    const json = pre({ permissionDecision: "defer", updatedInput: { a: 1 } });
    expect(decisionOf(run({ json })).updatedInput).toBeNull();
  });

  // hooks#json-output: `continue: false` "Claude stops processing entirely after the hook
  // runs. Takes precedence over any event-specific decision fields".
  test("continue:false stops Claude after the call; systemMessage is kept", () => {
    const json = pre({ permissionDecision: "deny" }, { continue: false, systemMessage: "m" });
    expect(decisionOf(run({ json }))).toMatchObject({ stop: true, systemMessage: "m" });
  });

  // hooks#exit-code-0: "exit 0 with a parsed object that fails schema validation is a
  // non-blocking error: the action proceeds"; hooks#json-output: `hookSpecificOutput`
  // "requires a `hookEventName` field set to the event name".
  test.each([
    ["a permissionDecision that is not one of the four", pre({ permissionDecision: "yes" })],
    ["hookSpecificOutput for another event", { hookSpecificOutput: { hookEventName: "Stop" } }],
  ])("%s is a non-blocking error: the call proceeds", (_name, json) => {
    const d = decisionOf(run({ json }));
    expect(d.outcome).toBe("proceed");
    expect(d.hookErrors).toHaveLength(1);
  });
});

// hooks#exit-code-2: "exit 2 blocks whether or not you print JSON: even a JSON
// `permissionDecision` of `"allow"` can't override it"; "The blocking message is the reason
// from your JSON's blocking decision when it makes one, and your stderr text otherwise";
// "A hook that exits 2 while printing JSON that fails [JSON output] schema validation still
// blocks: Claude Code uses stderr as the blocking reason".
describe("one handler: exit 2 always blocks", () => {
  test("plain stderr is the reason Claude sees", () => {
    expect(decisionOf(run({ exitCode: 2, stderr: "blocked\n" }))).toMatchObject({
      outcome: "deny",
      reason: "blocked",
    });
  });

  test("a JSON allow cannot override it; the reason is stderr", () => {
    const json = pre({ permissionDecision: "allow", permissionDecisionReason: "fine" });
    expect(decisionOf(run({ exitCode: 2, stderr: "blocked", json }))).toMatchObject({
      outcome: "deny",
      reason: "blocked",
    });
  });

  test("a JSON deny's reason wins over stderr", () => {
    const json = pre({ permissionDecision: "deny", permissionDecisionReason: "policy" });
    expect(decisionOf(run({ exitCode: 2, stderr: "x", json }))).toMatchObject({
      outcome: "deny",
      reason: "policy",
    });
  });

  test.each([
    ["an invalid permissionDecision", { json: pre({ permissionDecision: "yes" }) }],
    [
      "hookSpecificOutput for another event",
      { json: { hookSpecificOutput: { hookEventName: "Stop" } } },
    ],
    ["stdout that fails to parse", { json: null, hookError: "invalid JSON output: x" }],
  ])("with %s it still blocks, stderr as the reason", (_name, o) => {
    const d = decisionOf(run({ exitCode: 2, stderr: "blocked", ...o }));
    expect(d).toMatchObject({ outcome: "deny", reason: "blocked" });
  });
});

// hooks#other-exit-codes: with valid JSON "Claude Code ignores the exit code and the JSON
// alone decides"; without it "a non-blocking error … the action proceeds"; "A hook that
// can't start lands in the same non-blocking bucket"; hooks#timeouts: no decision.
describe("one handler: other exit codes, spawn failures, timeouts", () => {
  test("exit 1 with a valid JSON deny: the JSON decides", () => {
    const json = pre({ permissionDecision: "deny", permissionDecisionReason: "r" });
    expect(decisionOf(run({ exitCode: 1, json }))).toMatchObject({ outcome: "deny", reason: "r" });
  });

  test.each([
    [
      "exit 1 without JSON",
      run({ exitCode: 1, hookError: "Failed with non-blocking status code: 1" }),
    ],
    [
      "a hook that cannot start",
      run({ exitCode: 127, hookError: "Failed with non-blocking status code: x" }),
    ],
    ["a hook cancelled at its timeout", run({ exitCode: null, hookError: "timeout" })],
  ])("%s proceeds with a hook error", (_name, r) => {
    const d = decisionOf(r);
    expect(d.outcome).toBe("proceed");
    expect(d.hookErrors).toEqual([r.hookError ?? ""]);
  });
});

function decided(outcome: PreDecision["outcome"], o: Partial<PreDecision> = {}): PreDecision {
  return {
    outcome,
    reason: outcome,
    updatedInput: null,
    context: [],
    stop: false,
    systemMessage: null,
    hookErrors: [],
    ms: 10,
    ...o,
  };
}

// hooks#pretooluse-decision-control: "When multiple PreToolUse hooks return different
// decisions, precedence is `deny` > `defer` > `ask` > `allow`." hooks#hook-handler-fields:
// "All matching hooks run in parallel." hooks-guide (limitations): "When multiple
// `PreToolUse` hooks return `updatedInput` … the last one to finish takes effect."
describe("several handlers on one call", () => {
  test.each([
    [["allow", "deny"], "deny"],
    [["ask", "deny", "allow"], "deny"],
    [["allow", "defer", "ask"], "defer"],
    [["allow", "ask"], "ask"],
    [["proceed", "allow"], "allow"],
    [["proceed", "proceed"], "proceed"],
  ] as const)("%p → %s, with the winner's reason", (outcomes, winner) => {
    const d = combine(outcomes.map((o) => decided(o)));
    expect(d.outcome).toBe(winner);
    expect(d.reason).toBe(winner === "proceed" ? null : winner);
  });

  test("no handler at all decides nothing", () => {
    expect(combine([])).toMatchObject({ outcome: "proceed", reason: null, updatedInput: null });
  });

  test("the updatedInput of the handler that finished last wins, whatever the list order", () => {
    const d = combine([
      decided("allow", { updatedInput: { v: "slow" }, ms: 50 }),
      decided("allow", { updatedInput: { v: "fast" }, ms: 5 }),
      decided("allow", { ms: 90 }),
    ]);
    expect(d.updatedInput).toEqual({ v: "slow" });
  });

  test("one continue:false stops Claude; contexts and hook errors add up", () => {
    const d = combine([
      decided("allow", { context: ["a"], hookErrors: ["e1"] }),
      decided("deny", { stop: true, context: ["b"], systemMessage: "m" }),
      decided("proceed", { hookErrors: ["e2"] }),
    ]);
    expect(d).toMatchObject({ stop: true, context: ["a", "b"], hookErrors: ["e1", "e2"] });
    expect(d.systemMessage).toBe("m");
  });

  test("a jev-cops exit-2 deny wins over another hook's allow with a rewrite", () => {
    const ours = decisionOf(run({ exitCode: 2, stderr: "jev-cops: blocked" }));
    const theirs = decisionOf(
      run({ json: pre({ permissionDecision: "allow", updatedInput: { command: "true" } }) }),
    );
    expect(combine([theirs, ours])).toMatchObject({ outcome: "deny", reason: "jev-cops: blocked" });
  });
});
