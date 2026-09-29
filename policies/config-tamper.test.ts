import { afterEach, describe, expect, test } from "bun:test";
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
} from "@jevdict/core";
import {
  startTestDaemon,
  type TestDaemon,
  withFreshId,
} from "../packages/daemon/src/testing/daemon.ts";
import { buildEvent } from "../tests/fixtures/context/index.ts";
import configTamper from "./config-tamper.ts";

/**
 * What the fixtures cannot express: a human-granted precedent never lowers a
 * config-tamper kill (spec §Precedents, D-035), checked through the real engine, alone
 * and with the whole starter set; and, through a real jevdictd, observe mode turning the
 * kill into an allow with the "would have" note, and `[policy] protectedPaths` reaching
 * the policy.
 */

const HOME = "/home/dev";

function write(path: string): PreEvent {
  const parsed = parseEvent({
    schema: "jevdict.event/1",
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
): Promise<string> {
  const engine = createPolicyEngine({
    policies,
    judge: createDisabledJudge(),
    contextConfig: resolveContextConfig({ home: HOME }),
    policyConfig: resolvePolicyConfig({ when: { budgetMs: 50 } }),
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

describe("config-tamper through jevdictd", () => {
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

  test("observe: the kill is returned as allow with what jevdict would have done", async () => {
    const body = await judge("observe", "/home/dev/.claude/settings.json");
    expect(body.verdict).toBe("allow");
    expect(body.context_note).toStartWith("jevdict would have: kill");
  });

  test("[policy] protectedPaths from the daemon config reaches the policy", async () => {
    const body = await judge("enforce", "/home/dev/bin/jevdict-hook", ["~/bin/jevdict-hook"]);
    expect(body.verdict).toBe("kill");
  });
});
