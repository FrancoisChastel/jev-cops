import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SCENARIOS } from "../goldens/scenarios.ts";
import { CANNED, createFakeOpenShell } from "../testing/fake-openshell.ts";
import { openShellCli } from "./cli.ts";
import { compilePolicy } from "./compile.ts";
import {
  advisorProblems,
  sandboxCreate,
  sandboxGet,
  sandboxLogs,
  sandboxStop,
  settingsGet,
} from "./sandbox.ts";

const root = mkdtempSync(join(tmpdir(), "jev-cops-sandbox-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

function cliFor(binary: string) {
  const made = openShellCli({ binary, home: "/home/op", pathEnv: "/usr/bin:/bin" });
  if (!made.ok) throw new Error(made.error);
  return made.value;
}

const golden = compilePolicy(SCENARIOS[0]?.input ?? ({} as never)).yaml ?? "";
const policyFile = join(root, "policy.yaml");
writeFileSync(policyFile, golden);
const CREATE = {
  name: "sb",
  from: "claude-agent:local",
  policyFile,
  providers: ["anthropic"],
  env: [],
  command: [],
};

describe("sandboxCreate (D-109, D-119)", () => {
  test("creates with the compiled policy, then pins the advisor settings", async () => {
    const fake = createFakeOpenShell(join(root, "create"), [
      { match: ["sandbox", "create"], stdout: CANNED.sandboxGet("Ready") },
    ]);
    const made = await sandboxCreate(cliFor(fake.binary), CREATE);
    expect(made).toEqual({ ok: true, value: { name: "sb", phase: "Ready", policyVersion: 3 } });
    expect(fake.calls().map((c) => c.argv)).toEqual([
      [
        "sandbox",
        "create",
        "--name",
        "sb",
        "--from",
        "claude-agent:local",
        "--policy",
        policyFile,
        "--no-auto-providers",
        "--approval-mode",
        "manual",
        "--provider",
        "anthropic",
        "--detach",
        "--output",
        "json",
      ],
      ["settings", "set", "sb", "--key", "agent_policy_proposals_enabled", "--value", "false"],
      ["settings", "set", "sb", "--key", "proposal_approval_mode", "--value", "manual"],
    ]);
  });

  test("the fake rejects an invalid policy file, as sandbox create does", async () => {
    const bad = join(root, "bad.yaml");
    writeFileSync(bad, "version: 1\nfilesystem_policy:\n  read_write: [/]\n");
    const fake = createFakeOpenShell(join(root, "bad"));
    const made = await sandboxCreate(cliFor(fake.binary), { ...CREATE, policyFile: bad });
    expect(!made.ok && made.error).toContain("read_write");
    expect(fake.calls()).toHaveLength(1);
  });

  test("advisor settings that cannot be pinned stop the sandbox (fail closed)", async () => {
    const fake = createFakeOpenShell(join(root, "settings"), [
      { match: ["sandbox", "create"], stdout: CANNED.sandboxGet("Ready") },
      { match: ["settings", "set"], exit: 1, stderr: "global value set" },
    ]);
    const made = await sandboxCreate(cliFor(fake.binary), CREATE);
    expect(!made.ok && made.error).toContain("stopped");
    expect(fake.calls().at(-1)?.argv).toEqual(["sandbox", "stop", "sb"]);
  });
});

describe("sandbox get / stop / logs, settings get", () => {
  test("argv and parsing", async () => {
    const fake = createFakeOpenShell(join(root, "misc"), [
      { match: ["sandbox", "get"], stdout: CANNED.sandboxGet("Stopped") },
      {
        match: ["settings", "get"],
        stdout: CANNED.settings({ proposal_approval_mode: { value: "auto", scope: "global" } }),
      },
      { match: ["logs"], stdout: "NET:OPEN [MED] DENIED /usr/bin/curl(64) -> x:443\n" },
    ]);
    const cli = cliFor(fake.binary);
    const got = await sandboxGet(cli, "sb");
    expect(got.ok && got.value.phase).toBe("Stopped");
    expect((await sandboxStop(cli, "sb")).ok).toBe(true);
    const logs = await sandboxLogs(cli, "sb", { source: "sandbox", since: "10m" });
    expect(logs.ok && logs.value).toContain("DENIED");
    const settings = await settingsGet(cli, "sb");
    expect(settings.ok && advisorProblems(settings.value)).toEqual([
      "proposal_approval_mode is auto (global): agent-proposed hosts would bypass the judge (D-119)",
    ]);
    expect(fake.calls().map((c) => c.argv)).toEqual([
      ["sandbox", "get", "sb", "--output", "json"],
      ["sandbox", "stop", "sb"],
      ["logs", "sb", "-n", "200", "--source", "sandbox", "--since", "10m"],
      ["settings", "get", "sb", "--json"],
    ]);
  });

  test("failures are errors, never defaults", async () => {
    const fake = createFakeOpenShell(join(root, "fail"), [{ match: [], exit: 1, stderr: "down" }]);
    const cli = cliFor(fake.binary);
    expect((await sandboxGet(cli, "sb")).ok).toBe(false);
    expect((await sandboxStop(cli, "sb")).ok).toBe(false);
    expect((await sandboxLogs(cli, "sb", {})).ok).toBe(false);
    expect((await settingsGet(cli, "sb")).ok).toBe(false);
    fake.respond([{ match: [], stdout: "{}" }]);
    expect((await settingsGet(cli, "sb")).ok).toBe(false);
    expect((await sandboxGet(cli, "sb")).ok).toBe(false);
    expect(
      advisorProblems({ agent_policy_proposals_enabled: { value: "true", scope: "sandbox" } }),
    ).toHaveLength(1);
  });
});
