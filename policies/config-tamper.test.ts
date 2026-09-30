import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  createCaseFile,
  createDisabledJudge,
  createPolicyEngine,
  loadPolicies,
  type PolicyDefinition,
  type PrecedentLookup,
  type PreEvent,
  parseEvent,
  resolveContextConfig,
  resolvePolicyConfig,
} from "@jev-cops/core";
import { judgeInputPaths } from "../packages/daemon/src/protected-paths.ts";
import {
  startTestDaemon,
  type TestDaemon,
  testConfig,
  withFreshId,
} from "../packages/daemon/src/testing/daemon.ts";
import { buildEvent } from "../tests/fixtures/context/index.ts";
import configTamper from "./config-tamper.ts";

/**
 * What the fixtures cannot express: a human-granted precedent never lowers a
 * config-tamper kill (spec §Precedents, D-035), checked through the real engine, alone
 * and with the whole starter set; and, through a real copsd, observe mode turning the
 * kill into an allow with the "would have" note, `[policy] protectedPaths` and the
 * daemon's own private paths reaching the policy, and the agent-safe reasons of a hold;
 * and the daemon's own protected paths covering the policies dir, `_lib/` included.
 */

const HOME = "/home/dev";

function write(path: string): PreEvent {
  const parsed = parseEvent({
    schema: "jev-cops.event/1",
    id: "evt_01M3PP8CTP0010000000000000",
    phase: "pre",
    harness: "claude-code",
    session: { id: "sess_ct_precedent", parent_id: null, mode: "interactive" },
    call: {
      id: "call_ct_precedent",
      tool: "Write",
      kind: "fs.write",
      input: { file_path: path, content: "{}" },
      cwd: "/work/repo",
    },
    env: { git: { repo: "/work/repo", branch: "feat/x" }, sandbox: { kind: "openshell" } },
  });
  if (!parsed.ok || parsed.value.phase !== "pre") throw new Error("invalid fixture event");
  return parsed.value;
}

/** A store that grants the widest precedent it can to every event. */
const ALWAYS: PrecedentLookup = {
  lookup: () => ({ key: "fs.write|*", riskDelta: 0.3, policies: ["config-tamper"] }),
};

async function verdictFor(
  path: string,
  policies: readonly PolicyDefinition[] = [configTamper],
  protectedPaths: readonly string[] = [],
): Promise<string> {
  const engine = createPolicyEngine({
    policies,
    judge: createDisabledJudge(),
    contextConfig: resolveContextConfig({ home: HOME }),
    policyConfig: resolvePolicyConfig({
      when: { budgetMs: 50 },
      protectedPaths: [...protectedPaths],
    }),
    precedents: ALWAYS,
  });
  const cf = createCaseFile("sess_ct_precedent", { config: { home: HOME } });
  const { decision } = await engine.judge(write(path), cf, { home: HOME });
  return decision.verdict;
}

describe("config-tamper and precedents (D-035)", () => {
  test("a matching precedent never lowers a kill", async () => {
    expect(await verdictFor(`${HOME}/.claude/settings.json`)).toBe("kill");
  });

  test("nor with the whole starter set", async () => {
    const { policies } = await loadPolicies(import.meta.dir);
    expect(await verdictFor("/work/repo/.claude/settings.local.json", policies)).toBe("kill");
  });

  test("while a precedent does waive a config-tamper hold it names (a human decision)", async () => {
    expect(await verdictFor(`${HOME}/.claude/skills/x/SKILL.md`)).toBe("allow");
  });
});

describe("the daemon's own protectedPaths cover the policies dir whole (D-082)", () => {
  // The policies dir sits apart from the audit log, store and sockets, so only its own
  // entry can protect the helpers under it.
  const config = {
    ...testConfig("/srv/jv", { policies: {} }),
    policies: { dir: "/srv/jv-policies" },
  };
  const inputs = {
    configFiles: ["/srv/jv-etc/cops.toml"],
    selfBinary: null,
    osHome: HOME,
    cwd: "/",
  };
  const helper = "/srv/jv-policies/_lib/config-trees.ts";

  test("a write to a helper under policies/_lib/ is a kill", async () => {
    const own = judgeInputPaths(config, inputs);
    expect(own).toContain("/srv/jv-policies");
    expect(await verdictFor(helper, [configTamper], own)).toBe("kill");
  });

  test("and it is the policies dir entry that makes it one", async () => {
    const without = judgeInputPaths(config, inputs).filter((p) => !p.endsWith("/jv-policies"));
    expect(await verdictFor(helper, [configTamper], without)).toBe("allow");
  });
});

describe("config-tamper through copsd", () => {
  let td: TestDaemon | null = null;
  afterEach(async () => {
    await td?.stop();
    td = null;
  });

  async function judge(mode: "observe" | "enforce", path: string, protectedPaths: string[] = []) {
    td = await startTestDaemon({
      policies: {},
      policiesDir: import.meta.dir,
      mode,
      policy: { protectedPaths },
    });
    const input = { file_path: path, content: "{}" };
    const event = withFreshId(buildEvent({ tool: "Write", kind: "fs.write", input }));
    const res = await td.call("POST", "/v1/judge", event);
    return res.body as { verdict: string; reason: string; context_note: string | null };
  }

  test("enforce: a write to ~/.claude/settings.json is a kill with an agent-safe reason", async () => {
    const body = await judge("enforce", "/home/dev/.claude/settings.json");
    expect(body.verdict).toBe("kill");
    expect(body.reason).toBe(
      "Writing to /home/dev/.claude/settings.json would change the harness or judge configuration.",
    );
  });

  test("observe: the kill is returned as allow with what jev-cops would have done", async () => {
    const body = await judge("observe", "/home/dev/.claude/settings.json");
    expect(body.verdict).toBe("allow");
    expect(body.context_note).toStartWith("jev-cops would have: kill");
  });

  test("copsd boots on this directory, _lib/ included, and kills a write under _lib/", async () => {
    // Arrange: the daemon loads a copy of this directory, _lib/ included, and boots only
    // when the loader reports no problem (the kill is also the temp dir's, D-082).
    td = await startTestDaemon({ policies: {}, policiesDir: import.meta.dir });
    const input = {
      file_path: join(td.config.policies.dir, "_lib", "config-trees.ts"),
      content: "",
    };
    const event = withFreshId(buildEvent({ tool: "Write", kind: "fs.write", input }));
    // Act
    const res = await td.call("POST", "/v1/judge", event);
    // Assert
    expect(res.body).toMatchObject({ verdict: "kill" });
  });

  test("[policy] protectedPaths from the daemon config reaches the policy", async () => {
    const body = await judge("enforce", "/home/dev/bin/cops-hook", ["~/bin/cops-hook"]);
    expect(body.verdict).toBe("kill");
  });

  async function bash(command: string) {
    td ??= await startTestDaemon({ policies: {}, policiesDir: import.meta.dir });
    const session = { sessionId: `sess_ct_${crypto.randomUUID()}` };
    const event = withFreshId(
      buildEvent({ tool: "Bash", kind: "exec", input: { command } }, session),
    );
    const res = await td.call("POST", "/v1/judge", event);
    return res.body as { verdict: string; reason: string };
  }

  test("the daemon's own private paths reach the policy: reading its store is held", async () => {
    td = await startTestDaemon({ policies: {}, policiesDir: import.meta.dir });
    const body = await bash(`head -c 100 ${td.config.store.path}`);
    expect(body).toMatchObject({
      verdict: "hold",
      reason: `Reading ${td.config.store.path} would expose the judge's internal record.`,
    });
  });

  test.each([
    ["cops explain evt_01M3PP8CT01010000000000000", 'Running "cops explain" would expose'],
    ["pkill -f copsd", "Stopping the judge would block every later call."],
    ["cops install claude-code --uninstall", 'Running "cops install" would change the harness'],
  ])("%s is held with an agent-safe reason", async (command, reason) => {
    const body = await bash(command);
    expect(body.verdict).toBe("hold");
    expect(body.reason).toStartWith(reason);
  });
});
