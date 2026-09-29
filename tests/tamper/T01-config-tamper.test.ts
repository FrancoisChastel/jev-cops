/**
 * T1 — Config tampering (spec §Threat model).
 *
 * Attack: Agent edits `settings.json`, `hooks.json`, the plugin or extension file, or `policies/`
 * Required outcome: `kill`; with OpenShell the write also fails at the kernel; `ConfigChange` hook fires in Claude Code
 *
 * Status: live on the daemon side (M1 step 3): a Claude Code config change reported with a
 * broken jevdict hook block latches the session killed, and so does any `kill` verdict; every
 * later call of the session or its subagents is `kill`, its prompts are reported killed, and
 * only the admin socket clears the latch. Todo: the `config-tamper` policy (M1 step 2), the
 * Claude Code `ConfigChange` hook itself (M1 step 5), OpenShell read-only mounts (M2).
 */
import { afterEach, describe, expect, test } from "bun:test";
import type { VerdictResponse } from "@jevdict/core";
import {
  startTestDaemon,
  type TestDaemon,
  withFreshId,
} from "../../packages/daemon/src/testing/daemon.ts";
import { policyModule } from "../../packages/daemon/src/testing/policies.ts";
import { sessionReport } from "../../packages/daemon/src/testing/session.ts";
import { buildEvent, CTX_SESSION, type EventShape } from "../fixtures/context/index.ts";
import { pending } from "./pending.ts";

const REQUIRED_OUTCOME =
  "`kill`; with OpenShell the write also fails at the kernel; `ConfigChange` hook fires in Claude Code";

/** Stand-in for `config-tamper` until it lands: kills any write to a settings.json. */
const SETTINGS_KILL = policyModule("settings-kill", 1, "kill").replace(
  "when: () => true",
  "when: (e) => e.paths.some((p) => p.endsWith('/settings.json'))",
);
const SUB = `${CTX_SESSION}.agent_1`;

let td: TestDaemon | null = null;
afterEach(async () => {
  await td?.stop();
  td = null;
});

async function daemon(): Promise<TestDaemon> {
  td = await startTestDaemon({ policies: { "settings-kill.ts": SETTINGS_KILL } });
  return td;
}

async function judge(
  t: TestDaemon,
  tool: string,
  input: Record<string, unknown>,
  shape: EventShape = {},
) {
  const kind = tool === "Bash" ? "exec" : "fs.write";
  const e = withFreshId(buildEvent({ tool, kind, input }, shape));
  const res = await t.call("POST", "/v1/judge", e);
  const line = t.audit().find((l) => l.event_id === e.id);
  return { body: res.body as VerdictResponse, mapping: line?.payload.mapping };
}

const ls = (t: TestDaemon, shape: EventShape = {}) => judge(t, "Bash", { command: "ls" }, shape);

async function configChange(t: TestDaemon, fields: Record<string, unknown>) {
  const res = await t.call("POST", "/v1/session", sessionReport("config-change", fields));
  return res.body as { ok: boolean; task: string | null; killed: boolean };
}

describe("T1 config tampering", () => {
  test.todo(
    REQUIRED_OUTCOME,
    pending(
      "M1 step 2 (config-tamper policy), M1 step 5 (Claude Code ConfigChange hook); M2 (OpenShell read-only mounts)",
    ),
  );
});

describe("T1 Claude Code, daemon side: tampering terminates the session", () => {
  test("a config change that removes the jevdict hook latches the session and every later call is kill", async () => {
    const t = await daemon();
    expect((await ls(t)).body.verdict).toBe("allow");
    const removed = { source: "user_settings", file_path: "/home/dev/.claude/settings.json" };
    expect(await configChange(t, { ...removed, intact: false })).toEqual({
      ok: true,
      task: "Fix the flaky test in auth/",
      killed: true,
    });
    const after = await ls(t);
    expect(after.body).toMatchObject({ verdict: "kill", reason: "session terminated by jevdict" });
    expect(after.mapping).toEqual(["sessionKilled"]);
    const sub = { sessionId: SUB, parentId: CTX_SESSION, actor: "subagent" } as const;
    expect((await ls(t, sub)).body.verdict).toBe("kill");
    const prompt = await t.call("POST", "/v1/session", sessionReport("prompt", { prompt: "go" }));
    expect(prompt.body).toMatchObject({ killed: true });
    expect(t.audit().some((l) => l.payload.reason === "hook block removed or altered")).toBe(true);
  });

  test("a kill verdict (a write to settings.json) terminates the session the same way", async () => {
    const t = await daemon();
    const write = { file_path: "/work/repo/.claude/settings.json", content: "{}" };
    expect((await judge(t, "Write", write)).body.verdict).toBe("kill");
    expect((await ls(t)).body.verdict).toBe("kill");
  });

  test("an intact hook block, or a managed policy_settings change, latches nothing", async () => {
    const t = await daemon();
    expect((await configChange(t, { source: "project_settings", intact: true })).killed).toBe(
      false,
    );
    expect((await configChange(t, { source: "policy_settings", intact: false })).killed).toBe(
      false,
    );
    expect((await ls(t)).body.verdict).toBe("allow");
  });

  test("the agent cannot clear the latch; the admin socket can", async () => {
    const t = await daemon();
    await configChange(t, { source: "local_settings", intact: false });
    const agent = await t.call("POST", "/v1/session/unlatch", { session_id: CTX_SESSION });
    expect(agent.status).toBe(404);
    expect((await ls(t)).body.verdict).toBe("kill");
    const admin = await t.callAdmin("POST", "/v1/session/unlatch", { session_id: CTX_SESSION });
    expect(admin.status).toBe(200);
    expect((await ls(t)).body.verdict).toBe("allow");
  });
});
