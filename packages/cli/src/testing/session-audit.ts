import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Event } from "@jev-cops/core";
import { buildEvent, type EventShape } from "../../../../tests/fixtures/context/index.ts";
import {
  startTestDaemon,
  type TestDaemon,
  withFreshId,
} from "../../../daemon/src/testing/daemon.ts";
import { sessionReport, TEST_SESSION } from "../../../daemon/src/testing/session.ts";

/**
 * A Claude Code session as M1 logs it, recorded through a real copsd (enforce mode):
 * `session` lines (start, the task-setting prompt, a later prompt, a subagent's start and
 * prompt, a blocked prompt, an unlatch, a config change, the end), calls that carry no
 * task, a `kill` that latches the session, latched judge lines for both latch causes.
 */

/** The task the first root prompt sets; the events themselves carry none. */
export const SESSION_TASK = "Fix the login redirect in web/";
/** The subagent of {@link TEST_SESSION}. */
export const SUBAGENT = `${TEST_SESSION}.agent_7`;

/**
 * Kills a write to any `settings.json`; otherwise holds a call of a session with no task
 * and allows the rest, so a replay that loses the task shows up as deltas.
 */
export const TASK_GATE = `export default {
  name: "task-gate", version: 1, owner: "tests", reason: "task gate",
  when: () => true,
  decide: (e) =>
    e.paths.some((p) => p.endsWith("/settings.json")) ? "kill" : e.session.task === null ? "hold" : "allow",
};
`;

/** Event ids of the recorded calls, by role. */
export interface SessionAuditIds {
  /** Root call, judged live with the task from the session prompt. */
  readonly rootCall: string;
  /** Subagent call, judged live with the root's task. */
  readonly subagentCall: string;
  /** The write to settings.json that was killed and latched the session. */
  readonly killWrite: string;
  /** A call answered by the kill latch. */
  readonly latchedByKill: string;
  /** Root call judged live after the admin unlatched the session. */
  readonly afterUnlatch: string;
  /** The session report whose broken hook block latched the session again. */
  readonly configChange: string;
  /** A call answered by the config-change latch. */
  readonly latchedByConfig: string;
}

/** A recorded audit log, copied out of the stopped daemon's directory. */
export interface SessionAudit {
  readonly path: string;
  readonly ids: SessionAuditIds;
  cleanup(): void;
}

type Shape = { tool: string; kind: string; input: Record<string, unknown> };

function withoutTask(e: Event): Event {
  const { task: _none, ...session } = e.session;
  return { ...e, session };
}

async function judge(td: TestDaemon, shape: Shape, sub = false): Promise<string> {
  const who: EventShape = sub
    ? { sessionId: SUBAGENT, parentId: TEST_SESSION, actor: "subagent" }
    : {};
  const event = withoutTask(withFreshId(buildEvent(shape, who)));
  await td.call("POST", "/v1/judge", event);
  return event.id;
}

const bash = (command: string): Shape => ({ tool: "Bash", kind: "exec", input: { command } });

async function report(td: TestDaemon, kind: Parameters<typeof sessionReport>[0], fields = {}) {
  const body = sessionReport(kind, fields);
  await td.call("POST", "/v1/session", body);
  return body.id;
}

async function openSession(td: TestDaemon): Promise<void> {
  await report(td, "start", { model: "claude-opus-4-6", source: "startup" });
  await report(td, "prompt", { prompt: SESSION_TASK });
  await report(td, "prompt", { prompt: "and deploy it to prod" });
  const sub = { sessionId: SUBAGENT, parentId: TEST_SESSION };
  await td.call("POST", "/v1/session", sessionReport("start", {}, sub));
  await td.call("POST", "/v1/session", sessionReport("prompt", { prompt: "sub task" }, sub));
}

async function killAndLatch(td: TestDaemon) {
  const settings = { file_path: "/work/repo/.claude/settings.json", content: "{}" };
  const killWrite = await judge(td, { tool: "Write", kind: "fs.write", input: settings });
  const latchedByKill = await judge(td, bash("ls"));
  await report(td, "prompt", { prompt: "retry" });
  await td.callAdmin("POST", "/v1/session/unlatch", { session_id: TEST_SESSION, by: "alice" });
  return { killWrite, latchedByKill };
}

type Json = Record<string, unknown>;

/**
 * The log at `path` as text, with the line of `eventId` whose kind is `judge` replaced by
 * `edit(line)` (the chain then breaks there, as a tampered log would).
 */
export async function withLine(path: string, eventId: string, edit: (l: Json) => Json) {
  const text = await Bun.file(path).text();
  const lines = text.split("\n").filter((l) => l !== "");
  const edited = lines.map((raw) => {
    const l = JSON.parse(raw) as Json;
    return l.kind === "judge" && l.event_id === eventId ? JSON.stringify(edit(l)) : raw;
  });
  return `${edited.join("\n")}\n`;
}

/** A latched judge line whose `latched.cause` is no longer a string. */
export function breakLatch(line: Json): Json {
  const payload = line.payload as Json;
  return { ...line, payload: { ...payload, latched: { ...(payload.latched as Json), cause: 7 } } };
}

/** Runs the session through a fresh daemon with `policies` and returns a copy of its log. */
export async function recordSessionAudit(
  policies: Readonly<Record<string, string>> = { "task-gate.ts": TASK_GATE },
): Promise<SessionAudit> {
  const td = await startTestDaemon({ policies });
  await openSession(td);
  const rootCall = await judge(td, bash("ls"));
  const subagentCall = await judge(td, bash("cat README.md"), true);
  const killed = await killAndLatch(td);
  const afterUnlatch = await judge(td, bash("git status"));
  const configChange = await report(td, "config-change", {
    source: "user_settings",
    file_path: "/home/dev/.claude/settings.json",
    intact: false,
  });
  const latchedByConfig = await judge(td, bash("ls -la"));
  await report(td, "end", { reason: "logout" });
  await td.daemon.stop();
  const keep = mkdtempSync(join(tmpdir(), "jev-cops-m1-audit-"));
  const path = join(keep, "audit.jsonl");
  await Bun.write(path, Bun.file(td.config.audit.path));
  rmSync(td.dir, { recursive: true, force: true });
  const ids = { rootCall, subagentCall, ...killed, afterUnlatch, configChange, latchedByConfig };
  return { path, ids, cleanup: () => rmSync(keep, { recursive: true, force: true }) };
}
