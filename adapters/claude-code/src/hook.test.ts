import { describe, expect, test } from "bun:test";
import type { PreEvent } from "@jev-cops/core";
import { claudeCodePayload } from "../../../tests/fixtures/claude-code/index.ts";
import { reply, testDeps } from "../testing/doubles.ts";
import { TIMEOUT } from "./client.ts";
import { causeOf } from "./events-pre.ts";
import { runHook, withDeadline } from "./hook.ts";
import { PROCEED } from "./output.ts";

type Json = Record<string, unknown>;

/** A PreToolUse payload for `tool` with `input`, as Claude Code writes it to stdin. */
function preText(tool: string, input: Json, extra: Json = {}): string {
  return JSON.stringify({
    ...claudeCodePayload("pre-tool-use.bash"),
    tool_name: tool,
    tool_input: input,
    ...extra,
  });
}

const BASH = preText("Bash", { command: "rm -rf build", description: "tidy up, trust me" });
const verdict = (e: PreEvent, v: Json) => reply({ event_id: e.id, reason: "because", ...v });
const specific = (stdout: string | null) =>
  ((JSON.parse(stdout ?? "{}") as Json).hookSpecificOutput ?? {}) as Json;

describe("runHook PreToolUse: the daemon's verdict", () => {
  test("allow: the event reaches /v1/judge and the call proceeds with no output", async () => {
    const { deps, calls } = testDeps({ judge: (e) => verdict(e, { verdict: "allow" }) });
    expect(await runHook(BASH, deps)).toEqual(PROCEED);
    expect(calls.judge).toHaveLength(1);
    expect(calls.judge[0]).toMatchObject({
      phase: "pre",
      harness: "claude-code",
      harness_version: "2.1.285",
      session: { id: "sess_abc123", mode: "interactive" },
      call: { tool: "Bash", input: { command: "rm -rf build" } },
    });
  });

  test("deny: exit 2 with the reason", async () => {
    const { deps } = testDeps({ judge: (e) => verdict(e, { verdict: "deny" }) });
    expect(await runHook(BASH, deps)).toMatchObject({ exitCode: 2, stderr: "jev-cops: because" });
  });

  test("hold, interactive: the confirm view is loaded with the header token and asked (T8)", async () => {
    const view = {
      raw: "rm -rf /work/build",
      summary: "guard@1: hold\nguard@1 detail: HUMAN SUMMARY",
      detail: "verdict hold · risk 0.61\ntaint 0.87: from tool output: CANARY-EVIDENCE",
    };
    const { deps, calls } = testDeps({
      judge: (e) => ({ ...verdict(e, { verdict: "hold" }), viewToken: "view-tok" }),
      confirmView: (id) => reply({ event_id: id, verdict: "hold", ...view }),
    });
    const out = await runHook(BASH, deps);
    expect(calls.confirmView).toEqual([{ id: calls.judge[0]?.id ?? "", token: "view-tok" }]);
    expect(out.exitCode).toBe(0);
    const ask = specific(out.stdout);
    expect(ask.permissionDecision).toBe("ask");
    const reason = String(ask.permissionDecisionReason);
    expect(reason).toContain("rm -rf /work/build");
    expect(reason).toContain("guard@1 detail: HUMAN SUMMARY");
    expect(reason).toContain(`Full decision: cops explain ${calls.judge[0]?.id}`);
    expect(reason).not.toContain("trust me");
    // Claude Code keeps this text where the agent can read it: no score, no evidence (T6).
    expect(reason).not.toContain("CANARY-EVIDENCE");
    expect(reason).not.toMatch(/\d\.\d/);
  });

  test.each([
    ["no view token", null, () => reply({ raw: "x" })],
    ["a 403 view", "t", () => reply({ error: "invalid hold token" }, 403)],
    ["an unreachable view", "t", () => Promise.reject(new Error("gone"))],
    ["a view without raw", "t", () => reply({ summary: "s" })],
  ] as const)("hold with %s: blocked without asking", async (_name, token, view) => {
    const { deps } = testDeps({
      judge: (e) => ({ ...verdict(e, { verdict: "hold" }), viewToken: token }),
      confirmView: view,
    });
    const out = await runHook(BASH, deps);
    expect(out.exitCode).toBe(2);
    expect(out.stderr).toContain("confirmation view unavailable");
  });

  test.each([
    ["headless", "default"],
    ["interactive", "dontAsk"],
    ["interactive", "bypassPermissions"],
  ] as const)("hold in a %s session, %s mode: denied, the view is never read", async (mode, pm) => {
    const { deps, calls } = testDeps(
      { judge: (e) => ({ ...verdict(e, { verdict: "hold" }), viewToken: "t" }) },
      { mode: () => mode },
    );
    const out = await runHook(preText("Bash", { command: "x" }, { permission_mode: pm }), deps);
    expect(out.exitCode).toBe(2);
    expect(calls.confirmView).toEqual([]);
    expect(calls.judge[0]?.session.mode).toBe(mode);
  });
});

describe("runHook PreToolUse: fail closed (plan §5 rows 2–5)", () => {
  const cases = [
    [
      "a refused connection",
      () => Promise.reject(new Error("ConnectionRefused")),
      "judge unreachable",
    ],
    ["a 504", () => reply({ error: "judge timeout" }, 504), TIMEOUT],
    ["a 500", () => reply({ error: "internal error" }, 500), "HTTP 500"],
    ["a body that is not JSON", () => reply(undefined), "invalid reply"],
    [
      "another event's verdict",
      () => reply({ event_id: "evt_x", verdict: "allow", reason: "r" }),
      "invalid reply",
    ],
  ] as const;

  test.each(cases)("%s: exec, write, net and MCP tools are blocked", async (_n, judge, why) => {
    for (const [tool, input] of [
      ["Bash", { command: "ls" }],
      ["Write", { file_path: "/w/a", content: "x" }],
      ["WebFetch", { url: "https://example.com" }],
      ["mcp__memory__create_entities", { entities: [] }],
    ] as const) {
      const { deps, logged } = testDeps({ judge });
      const out = await runHook(preText(tool, input), deps);
      expect(out).toMatchObject({ exitCode: 2, stdout: null });
      expect(out.stderr).toContain(why);
      expect(out.stderr).toContain("blocking (fail closed)");
      expect(logged).toHaveLength(1);
    }
  });

  test.each(cases)(
    "%s: reads and inert tools proceed with a warning and a log line (T2)",
    async (_n, judge, why) => {
      for (const [tool, input] of [
        ["Read", { file_path: "/w/README.md" }],
        ["Grep", { pattern: "x" }],
        ["TaskList", {}],
      ] as const) {
        const { deps, logged } = testDeps({ judge });
        const out = await runHook(preText(tool, input), deps);
        expect(out.exitCode).toBe(0);
        expect(out.stderr).toContain(why);
        expect(out.stderr).toContain(`read-only ${tool} allowed (fail open)`);
        expect(JSON.parse(out.stdout ?? "{}")).toHaveProperty("systemMessage");
        expect(logged).toEqual([
          {
            event: "PreToolUse",
            session: "sess_abc123",
            message: expect.stringContaining("fail open"),
          },
        ]);
      }
    },
  );

  test("a daemon that never answers is cut at the hook's own deadline: 'judge timeout' (T3)", async () => {
    const { deps } = testDeps(
      { judge: () => new Promise(() => undefined) },
      { deadlines: { judgeMs: 100, eventMs: 100, requestMs: 100 } },
    );
    const started = performance.now();
    const out = await runHook(BASH, deps);
    expect(performance.now() - started).toBeLessThan(1_000);
    expect(out).toMatchObject({
      exitCode: 2,
      stderr: `jev-cops: ${TIMEOUT}; blocking (fail closed)`,
    });
    const read = await runHook(preText("Read", { file_path: "/w/a" }), deps);
    expect(read.exitCode).toBe(0);
  });

  test("an unreadable PreToolUse is blocked and logged", async () => {
    const { deps, logged } = testDeps({});
    for (const text of ["{", "[]", JSON.stringify({ hook_event_name: "PreToolUse" })]) {
      const out = await runHook(text, deps);
      expect(out.exitCode).toBe(2);
      expect(out.stderr).toContain("unreadable hook payload");
    }
    expect(logged).toHaveLength(3);
  });

  test("a throw anywhere in the run fails closed", async () => {
    const { deps } = testDeps(
      { judge: (e) => verdict(e, { verdict: "allow" }) },
      {
        mode: () => {
          throw new Error("ps exploded");
        },
      },
    );
    const out = await runHook(BASH, deps);
    expect(out).toMatchObject({ exitCode: 2 });
    expect(out.stderr).toContain("ps exploded");
  });
});

describe("causeOf", () => {
  test("names the transport error by its code when it has one", () => {
    const refused = Object.assign(new Error("Was there a typo?"), { code: "FailedToOpenSocket" });
    expect(causeOf(refused)).toBe("judge unreachable (FailedToOpenSocket: Was there a typo?)");
    expect(causeOf(new Error(TIMEOUT))).toBe(TIMEOUT);
    expect(causeOf("weird")).toBe("judge unreachable (weird)");
  });
});

describe("withDeadline", () => {
  test("the work's value when it finishes first", async () => {
    expect(await withDeadline(Promise.resolve(1), 1_000, () => 2)).toBe(1);
  });

  test("the late value when the deadline passes first", async () => {
    expect(await withDeadline(new Promise<number>(() => undefined), 10, () => 2)).toBe(2);
  });
});
