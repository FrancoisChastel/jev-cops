import { describe, expect, test } from "bun:test";
import type { AuditLine } from "@jev-cops/daemon";
import {
  eventSessionOf,
  isLatchedLine,
  latchedView,
  rootSessionOf,
  sessionPromptTask,
  sessionTaskOf,
} from "./audit-session.ts";

/** Hand-built audit lines of every M1 kind (the chain fields are not checked here). */
let seq = 0;
function line(kind: AuditLine["kind"], payload: Record<string, unknown>, ids = {}): AuditLine {
  seq += 1;
  return { seq, at: 1_000 * seq, prev: "0", hash: "0", kind, payload, ...ids };
}

const ROOT = "sess_root";
const SUB = "sess_root.agent_1";
const NESTED = "sess_root.agent_1.agent_2";

const report = (session: string, parent: string | null, extra: Record<string, unknown>) =>
  line(
    "session",
    { harness: "claude-code", parent_id: parent, killed: false, ...extra },
    {
      session_id: session,
      event_id: `evt_${seq + 1}`,
    },
  );

const judgeEvent = (session: string, parent: string | null, task?: string) => ({
  session: { id: session, parent_id: parent, ...(task === undefined ? {} : { task }) },
  call: { tool: "Bash", input: { command: "ls" } },
});

const LATCHED = {
  event: judgeEvent(ROOT, null),
  latched: { root: ROOT, session: ROOT, cause: "kill", at: 5_000, event_id: "evt_kill" },
  returned: { verdict: "kill", reason: "session terminated by jev-cops" },
  mapping: ["sessionKilled"],
  enforcement: "enforce",
  home: "/home/dev",
};

const LINES: AuditLine[] = [
  line("boot", { event: "boot" }),
  report(ROOT, null, { report: "start", mode: "interactive" }),
  report(ROOT, null, { report: "prompt", task_set: true, task: "Fix the login bug" }),
  report(ROOT, null, { report: "prompt", task_set: false, prompt_sha256: "ab" }),
  report(SUB, ROOT, { report: "prompt", task_set: false, subagent: true }),
  line("judge", { event: judgeEvent(NESTED, SUB) }, { session_id: NESTED }),
  line("judge", LATCHED, { session_id: ROOT, event_id: "evt_latched" }),
  report(ROOT, null, { action: "unlatch", by: "alice", root: ROOT, cleared: 1 }),
  report(ROOT, null, { report: "config-change", source: "user_settings", intact: false }),
  report(ROOT, null, { report: "end", reason: "logout" }),
];

describe("sessions in the audit log", () => {
  test("a subagent's root follows parent links from session and judge lines", () => {
    expect(rootSessionOf(LINES, NESTED)).toBe(ROOT);
    expect(rootSessionOf(LINES, SUB)).toBe(ROOT);
    expect(rootSessionOf(LINES, ROOT)).toBe(ROOT);
    expect(rootSessionOf(LINES, "sess_unknown")).toBe("sess_unknown");
  });

  test("a parent cycle in a tampered log stops instead of looping", () => {
    const cyclic = [report("sess_a", "sess_b", {}), report("sess_b", "sess_a", {})];
    expect(["sess_a", "sess_b"]).toContain(rootSessionOf(cyclic, "sess_a"));
  });

  test("the task is the root's first prompt line that set one; subagents inherit it", () => {
    const found = sessionTaskOf(LINES, NESTED);
    expect(found).toEqual({ task: "Fix the login bug", seq: LINES[2]?.seq ?? -1 });
    expect(sessionTaskOf(LINES.slice(3), ROOT)).toBeNull();
  });

  test("only a root prompt line that set the task counts", () => {
    expect(sessionPromptTask(LINES[2] as AuditLine)).toEqual({
      sessionId: ROOT,
      task: "Fix the login bug",
    });
    for (const i of [1, 3, 4, 5, 7, 8, 9])
      expect(sessionPromptTask(LINES[i] as AuditLine)).toBeNull();
    const forged = report(SUB, ROOT, { report: "prompt", task: "a subagent never sets it" });
    expect(sessionPromptTask(forged)).toBeNull();
  });

  test("an event's session, and nothing from what is not an event", () => {
    expect(eventSessionOf(judgeEvent(SUB, ROOT, "t"))).toEqual({
      id: SUB,
      parentId: ROOT,
      task: "t",
    });
    expect(eventSessionOf(judgeEvent(ROOT, null))).toEqual({
      id: ROOT,
      parentId: null,
      task: null,
    });
    expect(eventSessionOf("not an event")).toBeNull();
  });
});

describe("latched judge lines", () => {
  test("a judge line answered by the latch: sessionKilled, a latched block, no decision", () => {
    expect(isLatchedLine(LINES[6] as AuditLine)).toBe(true);
    expect(isLatchedLine(LINES[5] as AuditLine)).toBe(false);
    expect(isLatchedLine(LINES[7] as AuditLine)).toBe(false);
    const view = latchedView(LINES[6] as AuditLine);
    expect(view).toMatchObject({ ok: true, payload: { latched: { cause: "kill" } } });
  });

  test("a latched line with a broken latched block is reported, never trusted", () => {
    const broken = line("judge", { ...LATCHED, latched: { root: ROOT } }, { session_id: ROOT });
    expect(isLatchedLine(broken)).toBe(true);
    const view = latchedView(broken);
    expect(view.ok).toBe(false);
    expect(view.ok ? "" : view.error).toContain("latched.");
  });
});
