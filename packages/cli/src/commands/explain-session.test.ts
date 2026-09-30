import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import type { AuditLine } from "@jev-cops/daemon";
import { captureIo } from "../io.ts";
import {
  breakLatch,
  recordSessionAudit,
  SESSION_TASK,
  type SessionAudit,
  withLine,
} from "../testing/session-audit.ts";
import { runExplainCommand } from "./explain.ts";
import { renderLatched, taskLine } from "./explain-session.ts";

/**
 * `cops explain` on an M1 Claude Code log: calls that carry no task, `session` lines
 * that set it, and judge lines answered by the kill latch (no decision, no policy ran).
 */

let log: SessionAudit;

beforeAll(async () => {
  log = await recordSessionAudit();
});

afterAll(() => log.cleanup());

async function explain(id: string, path = log.path) {
  const io = captureIo();
  const code = await runExplainCommand([id, "--audit", path], io);
  return { code, out: io.stdout.join("\n"), err: io.stderr.join("\n") };
}

describe("cops explain: the session's task", () => {
  test("a call with no task shows the task from the session's first prompt line", async () => {
    const { code, out } = await explain(log.ids.rootCall);
    expect(code).toBe(0);
    expect(out).toContain(`\ntask: ${SESSION_TASK} (from the session's first prompt, audit seq `);
    expect(out).toMatch(/audit seq \d+\)$/m);
    expect(out).not.toContain("and deploy it to prod");
  });

  test("a subagent's call shows its root's task", async () => {
    const { out } = await explain(log.ids.subagentCall);
    expect(out).toContain(`task: ${SESSION_TASK} (from the session's first prompt`);
  });
});

describe("cops explain: latched judge lines", () => {
  test("a call answered by a kill latch says the session was terminated, and by what", async () => {
    const { code, out, err } = await explain(log.ids.latchedByKill);
    expect(code).toBe(0);
    expect(err).toBe("");
    expect(out).toContain(
      `session terminated by jev-cops (latched since ${log.ids.killWrite}, cause kill)`,
    );
    expect(out).toContain("returned to the harness: kill (sessionKilled; enforcement enforce)");
    expect(out).toContain("no policy ran");
    expect(out).toContain(`cops explain ${log.ids.killWrite}`);
    expect(out).toContain(`task: ${SESSION_TASK}`);
    expect(out).toContain("call: Bash ls");
    expect(out).not.toContain("malformed");
  });

  test("a call answered by a config-change latch names the settings change", async () => {
    const { code, out } = await explain(log.ids.latchedByConfig);
    expect(code).toBe(0);
    expect(out).toContain(
      `session terminated by jev-cops (latched since ${log.ids.configChange}, cause config-change)`,
    );
    expect(out).toContain("config change: user_settings /home/dev/.claude/settings.json");
  });

  test("the kill that latched the session is a normal judge line with the latch related", async () => {
    const { out } = await explain(log.ids.killWrite);
    expect(out).toContain("verdict kill");
    expect(out).toContain("related: session latch");
  });

  test("--json prints the latched line as is", async () => {
    const io = captureIo();
    expect(
      await runExplainCommand([log.ids.latchedByKill, "--audit", log.path, "--json"], io),
    ).toBe(0);
    const out = JSON.parse(io.stdout.join("\n")) as { line: { payload: { mapping: string[] } } };
    expect(out.line.payload.mapping).toEqual(["sessionKilled"]);
  });

  test("a latched line whose latch block was tampered with is malformed (exit 1)", async () => {
    const broken = `${log.path}.broken`;
    writeFileSync(broken, await withLine(log.path, log.ids.latchedByKill, breakLatch));
    const { code, err } = await explain(log.ids.latchedByKill, broken);
    expect(code).toBe(1);
    expect(err).toContain("malformed audit line");
  });
});

describe("explain-session renderers on hand-built lines", () => {
  const NO_TASK = { session: { id: "sess_x", parent_id: null } };
  const latched = (cause: string, event: unknown = NO_TASK) => ({
    event,
    latched: { root: "sess_x", session: "sess_x", cause, at: 0, event_id: "evt_origin" },
    returned: { verdict: "kill" as const, reason: "session terminated by jev-cops" },
    mapping: ["sessionKilled"],
    enforcement: "enforce",
    home: "/home/dev",
  });
  const line = (payload: Record<string, unknown>): AuditLine => ({
    seq: 1,
    at: 0,
    prev: "0",
    hash: "0",
    kind: "judge",
    payload,
  });

  test("an unknown cause, an event without a session or call", () => {
    const p = latched("admin", "not an event");
    const out = renderLatched(line(p), p, [], []).join("\n");
    expect(out).toContain("event ? · session ? ·");
    expect(out).toContain("latched by evt_origin (cause admin)");
    expect(out).toContain("task: unknown (the recorded event names no session)");
    expect(out).toContain("call: unreadable");
  });

  test("a config-change latch whose report is not in the log; no task anywhere", () => {
    const p = latched("config-change");
    const out = renderLatched(line(p), p, [], []).join("\n");
    expect(out).toContain("config change: unknown settings lost the cops hook block");
    expect(taskLine(p.event, [])).toBe(
      "task: none recorded (not on the event, and no session prompt set one)",
    );
  });

  test("a long, multi-line task is shown flat and cut", () => {
    const event = { session: { id: "sess_x", parent_id: null, task: `a\n${"b".repeat(400)}` } };
    expect(taskLine(event, [])).toMatch(/^task: a b{298}…$/);
  });
});
