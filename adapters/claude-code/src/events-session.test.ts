import { describe, expect, test } from "bun:test";
import { claudeCodePayload } from "../../../tests/fixtures/claude-code/index.ts";
import { reply, testDeps } from "../testing/doubles.ts";
import { KILLED_PROMPT } from "./events-session.ts";
import { runHook } from "./hook.ts";
import { PROCEED } from "./output.ts";

type Json = Record<string, unknown>;
const text = (name: Parameters<typeof claudeCodePayload>[0], over: Json = {}) =>
  JSON.stringify({ ...claudeCodePayload(name), ...over });
const REFUSED = () => Promise.reject(new Error("ConnectionRefused"));
const NEVER = () => new Promise<never>(() => undefined);
const live = (killed = false) => reply({ ok: true, task: "t", killed });

describe("PostToolUse / PostToolUseFailure → /v1/observe (never blocks)", () => {
  test("the result is observed and the call proceeds", async () => {
    const { deps, calls } = testDeps({ observe: () => reply(null, 204) });
    expect(await runHook(text("post-tool-use.write"), deps)).toEqual(PROCEED);
    expect(calls.observe[0]).toMatchObject({
      phase: "post",
      session: { id: "sess_abc123", mode: "interactive" },
      call: { id: "call_toolu_01ABC123", tool: "Write" },
      result: { ok: true },
    });
  });

  test("a failure is observed as not ok, with its exit code", async () => {
    const { deps, calls } = testDeps({ observe: () => reply(null, 204) });
    await runHook(text("post-tool-use-failure.bash"), deps);
    expect(calls.observe[0]?.result).toMatchObject({ ok: false, exit_code: 1 });
  });

  test.each([
    ["an unreachable daemon", REFUSED],
    ["a 400", () => reply({ error: "bad" }, 400)],
  ])("%s: logged, exit 0, nothing for Claude or the user", async (_n, observe) => {
    const { deps, logged } = testDeps({ observe });
    const out = await runHook(text("post-tool-use.write"), deps);
    expect(out).toMatchObject({ exitCode: 0, stdout: null });
    expect(out.stderr).toContain("observe not recorded");
    expect(logged).toHaveLength(1);
  });
});

describe("UserPromptSubmit → /v1/session prompt", () => {
  test("the prompt is reported (the daemon pins the first as the task) and proceeds", async () => {
    const { deps, calls } = testDeps({ session: () => live() });
    expect(await runHook(text("user-prompt-submit"), deps)).toEqual(PROCEED);
    expect(calls.session[0]).toMatchObject({
      kind: "prompt",
      prompt: "Write a function to calculate the factorial of a number",
      session: { id: "sess_abc123", mode: "interactive" },
    });
  });

  test("a killed session's prompt is blocked (D-076)", async () => {
    const { deps } = testDeps({ session: () => live(true) });
    expect(await runHook(text("user-prompt-submit"), deps)).toEqual({
      exitCode: 2,
      stdout: JSON.stringify({ decision: "block", reason: `jev-cops: ${KILLED_PROMPT}` }),
      stderr: `jev-cops: ${KILLED_PROMPT}`,
    });
  });

  test.each([
    ["unreachable", REFUSED],
    ["a 500", () => reply({ error: "x" }, 500)],
  ])("daemon %s: the prompt proceeds with a warning and a log line", async (_n, session) => {
    const { deps, logged } = testDeps({ session });
    const out = await runHook(text("user-prompt-submit"), deps);
    expect(out.exitCode).toBe(0);
    expect(JSON.parse(out.stdout ?? "{}").systemMessage).toContain("not recorded");
    expect(logged).toHaveLength(1);
  });

  test("a daemon that never answers: the prompt proceeds at the deadline", async () => {
    const { deps } = testDeps(
      { session: NEVER },
      { deadlines: { judgeMs: 100, eventMs: 100, requestMs: 1_000 } },
    );
    expect((await runHook(text("user-prompt-submit"), deps)).exitCode).toBe(0);
  });
});

describe("SessionStart / SessionEnd → /v1/session start / end", () => {
  test("start carries model, source and mode", async () => {
    const { deps, calls } = testDeps({ session: () => live() }, { mode: () => "headless" });
    expect(await runHook(text("session-start"), deps)).toEqual(PROCEED);
    expect(calls.session[0]).toMatchObject({
      kind: "start",
      model: "claude-opus-5",
      source: "resume",
      session: { mode: "headless" },
    });
  });

  test("a resumed killed session warns the user", async () => {
    const { deps } = testDeps({ session: () => live(true) });
    const out = await runHook(text("session-start"), deps);
    expect(out.exitCode).toBe(0);
    expect(JSON.parse(out.stdout ?? "{}").systemMessage).toContain(
      "every tool call will be blocked",
    );
  });

  test("an unreachable daemon at start warns the user", async () => {
    const { deps } = testDeps({ session: REFUSED });
    const out = await runHook(text("session-start"), deps);
    expect(out.exitCode).toBe(0);
    expect(JSON.parse(out.stdout ?? "{}").systemMessage).toContain("judge unreachable");
  });

  test("end is best effort", async () => {
    const ok = testDeps({ session: () => live() });
    expect(await runHook(text("session-end"), ok.deps)).toEqual(PROCEED);
    expect(ok.calls.session[0]).toMatchObject({ kind: "end", reason: "other" });
    const down = testDeps({ session: REFUSED });
    expect(await runHook(text("session-end"), down.deps)).toMatchObject({
      exitCode: 0,
      stdout: null,
    });
  });
});

describe("ConfigChange → intact check, /v1/session config-change, block unless intact (T1)", () => {
  test("intact and reported: the change applies", async () => {
    const { deps, calls } = testDeps({ session: () => live() });
    expect(await runHook(text("config-change"), deps)).toEqual(PROCEED);
    expect(calls.session[0]).toMatchObject({
      kind: "config-change",
      source: "project_settings",
      intact: true,
    });
  });

  test("not intact: reported as such, and blocked", async () => {
    const { deps, calls, logged } = testDeps(
      { session: () => live(true) },
      { configCheck: () => ({ intact: false, why: "no cops hook on PreToolUse" }) },
    );
    const out = await runHook(text("config-change"), deps);
    expect(out.exitCode).toBe(2);
    expect(JSON.parse(out.stdout ?? "{}")).toEqual({
      decision: "block",
      reason: "jev-cops: settings change blocked: no cops hook on PreToolUse",
    });
    expect(calls.session[0]).toMatchObject({ intact: false });
    expect(logged).toHaveLength(1);
  });

  test.each([
    ["unreachable", REFUSED],
    ["a 400", () => reply({ error: "bad" }, 400)],
  ])("daemon %s: blocked even when intact (fail closed)", async (_n, session) => {
    const { deps } = testDeps({ session });
    const out = await runHook(text("config-change"), deps);
    expect(out.exitCode).toBe(2);
    expect(out.stderr).toContain("settings change blocked (fail closed)");
  });

  test("a daemon that never answers: blocked at the deadline", async () => {
    const { deps } = testDeps(
      { session: NEVER },
      { deadlines: { judgeMs: 100, eventMs: 100, requestMs: 1_000 } },
    );
    expect((await runHook(text("config-change"), deps)).exitCode).toBe(2);
  });

  test.each([
    ["reported", () => live()],
    ["unreachable", REFUSED],
  ])("policy_settings (cannot be blocked), %s: exit 0, logged", async (_n, session) => {
    const { deps, logged } = testDeps(
      { session },
      { configCheck: () => ({ intact: false, why: "gone" }) },
    );
    const out = await runHook(text("config-change", { source: "policy_settings" }), deps);
    expect(out).toMatchObject({ exitCode: 0, stdout: null });
    expect(logged[0]?.message).toContain("cannot be blocked");
  });
});

describe("malformed payloads (plan §5 row 5)", () => {
  test.each([
    ["UserPromptSubmit", 0],
    ["SessionStart", 0],
    ["SessionEnd", 0],
    ["PostToolUse", 0],
    ["PostToolUseFailure", 0],
    ["ConfigChange", 2],
    ["PreToolUse", 2],
  ] as const)("%s without its fields → exit %d", async (event, code) => {
    const { deps } = testDeps({});
    const out = await runHook(JSON.stringify({ hook_event_name: event }), deps);
    expect(out.exitCode).toBe(code);
    expect(out.stderr).toContain("unreadable hook payload");
  });
});
