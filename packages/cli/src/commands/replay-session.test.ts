import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildEvent } from "../../../../tests/fixtures/context/index.ts";
import { startTestDaemon, withFreshId } from "../../../daemon/src/testing/daemon.ts";
import { policyModule } from "../../../daemon/src/testing/policies.ts";
import { sessionReport, withHarness } from "../../../daemon/src/testing/session.ts";
import { captureIo } from "../io.ts";
import type { ReplayReport } from "../replay-engine.ts";
import {
  breakLatch,
  recordSessionAudit,
  type SessionAudit,
  TASK_GATE,
  withLine,
} from "../testing/session-audit.ts";
import { runReplayCommand } from "./replay.ts";

/**
 * `jevdict replay` on an M1 Claude Code log: the task comes from `session` prompt lines
 * (the events carry none), and judge lines answered by the kill latch are replayed as
 * `kill` and reported apart: the latch is state, not a policy decision.
 */

let log: SessionAudit;
let root: string;

beforeAll(async () => {
  log = await recordSessionAudit();
  root = mkdtempSync(join(tmpdir(), "jevdict-replay-m1-"));
});

afterAll(() => {
  log.cleanup();
  rmSync(root, { recursive: true, force: true });
});

function policies(name: string, gate: string): string {
  const dir = join(root, name);
  mkdirSync(dir);
  writeFileSync(join(dir, "task-gate.ts"), gate);
  return dir;
}

async function replay(dir: string, path = log.path) {
  const io = captureIo();
  const code = await runReplayCommand([path, "--policies", dir, "--json"], io);
  const text = io.stdout.join("\n");
  return { code, report: JSON.parse(text) as ReplayReport };
}

async function replayText(dir: string): Promise<string> {
  const io = captureIo();
  await runReplayCommand([log.path, "--policies", dir], io);
  return io.stdout.join("\n");
}

describe("jevdict replay: session lines", () => {
  test("the task is rebuilt from the root's first prompt: unchanged policies, zero deltas", async () => {
    const { code, report } = await replay(policies("same", TASK_GATE));
    expect(code).toBe(0);
    expect(report.problems).toEqual([]);
    expect(report.events.map((e) => e.eventId)).toEqual([
      log.ids.rootCall,
      log.ids.subagentCall,
      log.ids.killWrite,
      log.ids.afterUnlatch,
    ]);
    expect(report.deltas).toBe(0);
  });
});

describe("jevdict replay: a root's end line expires its precedents, as in the daemon", () => {
  const GUARD = policyModule("guard", 1, "hold").replace(
    "when: () => true",
    'when: (e) => e.kind === "fs.delete"',
  );
  const RM = { tool: "Bash", kind: "exec", input: { command: "rm -rf /srv/data" } };

  test("a call after the end is not waived by a precedent granted before it", async () => {
    const td = await startTestDaemon({ policies: { "guard.ts": GUARD } });
    const rm = () => withHarness(withFreshId(buildEvent(RM, { task: "t" })), "pi");
    const held = rm();
    const token = ((await td.call("POST", "/v1/judge", held)).body as { hold_token: string })
      .hold_token;
    const grant = { event_id: held.id, decision: "allow", by: "alice", hold_token: token };
    expect((await td.call("POST", "/v1/resolve", grant)).status).toBe(200);
    await td.call("POST", "/v1/session", sessionReport("end", {}, { harness: "pi" }));
    const after = rm();
    await td.call("POST", "/v1/judge", after);
    await td.daemon.stop();
    const path = join(root, "ended.jsonl");
    await Bun.write(path, Bun.file(td.config.audit.path));
    rmSync(td.dir, { recursive: true, force: true });
    const dir = join(root, "ended");
    mkdirSync(dir);
    writeFileSync(join(dir, "guard.ts"), GUARD);
    const { report } = await replay(dir, path);
    expect(report.events.find((e) => e.eventId === after.id)).toMatchObject({
      old: "hold",
      next: "hold",
    });
    expect(report.deltas).toBe(0);
  });
});

describe("jevdict replay: latched judge lines", () => {
  test("replayed as kill, reported apart, never a delta or a problem", async () => {
    const { report } = await replay(policies("latched", TASK_GATE));
    expect(report.latched.map((l) => [l.eventId, l.verdict, l.cause, l.latchedBy])).toEqual([
      [log.ids.latchedByKill, "kill", "kill", log.ids.killWrite],
      [log.ids.latchedByConfig, "kill", "config-change", log.ids.configChange],
    ]);
    expect(report.latched[0]?.notes.join("\n")).toContain("state, not a policy decision");
    expect(report.events.some((e) => e.eventId === log.ids.latchedByKill)).toBe(false);
  });

  test("when the latching kill no longer replays as kill, the latched call says so", async () => {
    const softened = TASK_GATE.replace('? "kill"', '? "hold"');
    const { report } = await replay(policies("softened", softened));
    expect(report.deltas).toBe(1);
    expect(report.events.find((e) => e.eventId === log.ids.killWrite)).toMatchObject({
      old: "kill",
      next: "hold",
    });
    const byKill = report.latched.find((l) => l.eventId === log.ids.latchedByKill);
    expect(byKill?.notes.join("\n")).toContain(`${log.ids.killWrite}) now replays as hold`);
    const byConfig = report.latched.find((l) => l.eventId === log.ids.latchedByConfig);
    expect(byConfig?.notes).toHaveLength(1);
  });

  test("the text report lists latched calls after the deltas and counts them apart", async () => {
    const text = await replayText(policies("text", TASK_GATE));
    expect(text).toContain(
      `${log.ids.latchedByKill}  kill (latched since ${log.ids.killWrite}, cause kill; not a policy decision)`,
    );
    expect(text).toContain("2 latched call(s) replayed as kill");
    expect(text).toMatch(/^0 deltas$/m);
    expect(text).not.toContain("PROBLEM");
    const softened = await replayText(
      policies("text-soft", TASK_GATE.replace('? "kill"', '? "hold"')),
    );
    expect(softened).toContain(`${log.ids.latchedByKill}  note: the call that latched it`);
    expect(softened).toMatch(/^1 delta$/m);
  });

  test("a latched line whose latch block was tampered with is a problem", async () => {
    const broken = join(root, "broken.jsonl");
    writeFileSync(broken, await withLine(log.path, log.ids.latchedByKill, breakLatch));
    const { report } = await replay(policies("broken", TASK_GATE), broken);
    expect(report.problems).toEqual([expect.stringContaining("latched.cause")]);
    expect(report.latched).toHaveLength(1);
  });
});
