import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CANNED, createFakeOpenShell } from "../testing/fake-openshell.ts";
import { type OpenShellCli, openShellCli, openShellEnv } from "./cli.ts";

const root = mkdtempSync(join(tmpdir(), "jev-cops-cli-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const UPDATE = {
  ruleName: "jev_cops_task_hosts",
  addEndpoint: "docs.example.com:443:read-only:rest:enforce",
  binaries: ["/usr/local/bin/claude"],
};

function cliFor(binary: string, over: object = {}): OpenShellCli {
  const made = openShellCli({
    binary,
    home: "/home/op",
    pathEnv: "/usr/bin:relative:/bin",
    ...over,
  });
  if (!made.ok) throw new Error(made.error);
  return made.value;
}

describe("openShellCli", () => {
  test("refuses a binary that is not an absolute path", () => {
    expect(openShellCli({ binary: "openshell", home: "/h" }).ok).toBe(false);
  });

  test("scrubbed environment: nothing inherited, absolute PATH only", async () => {
    const fake = createFakeOpenShell(join(root, "env"));
    process.env.OPENSHELL_SANDBOX_POLICY = "/tmp/evil.yaml";
    process.env.OPENSHELL_GATEWAY_INSECURE = "1";
    try {
      await cliFor(fake.binary, { gateway: "local", workspace: "team" }).version();
    } finally {
      delete process.env.OPENSHELL_SANDBOX_POLICY;
      delete process.env.OPENSHELL_GATEWAY_INSECURE;
    }
    const env = fake.calls()[0]?.env ?? {};
    expect(env.PATH).toBe("/usr/bin:/bin");
    expect(env.HOME).toBe("/home/op");
    expect(env.OPENSHELL_GATEWAY).toBe("local");
    expect(env.OPENSHELL_WORKSPACE).toBe("team");
    expect(env.NO_COLOR).toBe("1");
    expect(env.OPENSHELL_SANDBOX_POLICY).toBeUndefined();
    expect(env.OPENSHELL_GATEWAY_INSECURE).toBeUndefined();
    expect(Object.keys(openShellEnv({ binary: "/x", home: "/h" })).sort()).toEqual([
      "HOME",
      "NO_COLOR",
      "OPENSHELL_NO_BROWSER",
      "PATH",
    ]);
  });

  test("policy update: exact argv, --wait exit codes mapped (manage-policies.mdx:254-258)", async () => {
    const fake = createFakeOpenShell(join(root, "update"));
    const cli = cliFor(fake.binary);
    expect((await cli.policyUpdate("sb", UPDATE)).status).toBe("applied");
    expect(fake.calls()[0]?.argv).toEqual([
      "policy",
      "update",
      "sb",
      "--rule-name",
      "jev_cops_task_hosts",
      "--binary",
      "/usr/local/bin/claude",
      "--add-endpoint",
      "docs.example.com:443:read-only:rest:enforce",
      "--wait",
      "--timeout",
      "20",
    ]);
    const cases: ReadonlyArray<[number, string]> = [
      [1, "rejected"],
      [124, "timeout"],
      [2, "failed"],
    ];
    for (const [exit, status] of cases) {
      fake.respond([{ match: ["policy"], exit, stderr: "why" }]);
      const r = await cli.policyUpdate("sb", UPDATE);
      expect([r.status, r.code, r.stderr]).toEqual([status, exit, "why"]);
    }
    fake.respond([{ match: ["policy"], exit: 0 }]);
    expect((await cli.removeRule("sb", "jev_cops_task_hosts")).status).toBe("applied");
    expect(fake.calls().at(-1)?.argv).toContain("--remove-rule");
  });

  test("a hung call is killed at the deadline", async () => {
    const fake = createFakeOpenShell(join(root, "slow"), [{ match: ["policy"], sleepMs: 5_000 }]);
    const cli = cliFor(fake.binary, { waitDeadlineMs: 300 });
    const r = await cli.policyUpdate("sb", UPDATE);
    expect(r.status).toBe("deadline");
  });

  test("a binary that cannot start is not-run", async () => {
    const r = await cliFor(join(root, "missing-openshell")).policySet("sb", "/p.yaml");
    expect(r.status).toBe("not-run");
  });

  test("policy get --base: the policy field through the schema mirror", async () => {
    const policy = { version: 1 as const, filesystem_policy: { read_only: ["/usr"] } };
    const fake = createFakeOpenShell(join(root, "get"), [
      { match: ["policy", "get"], stdout: CANNED.policyGet(policy, 7) },
    ]);
    const cli = cliFor(fake.binary);
    const got = await cli.policyGetBase("sb");
    expect(got.ok && got.value).toEqual({ version: 7, policy });
    expect(fake.calls()[0]?.argv).toEqual(["policy", "get", "sb", "--base", "--output", "json"]);
    fake.respond([{ match: ["policy"], stdout: CANNED.policyGet({ version: 2 }) }]);
    expect((await cli.policyGetBase("sb")).ok).toBe(false);
    fake.respond([{ match: ["policy"], stdout: "not json" }]);
    expect((await cli.policyGetBase("sb")).ok).toBe(false);
    fake.respond([{ match: ["policy"], exit: 1, stderr: "no gateway" }]);
    const failed = await cli.policyGetBase("sb");
    expect(!failed.ok && failed.error).toContain("no gateway");
  });

  test("policy list: revisions, and whether the latest is Loaded", async () => {
    const fake = createFakeOpenShell(join(root, "list"), [
      {
        match: ["policy", "list"],
        stdout: CANNED.policyList([
          { version: 2, status: "loaded" },
          { version: 3, status: "loaded" },
        ]),
      },
    ]);
    const cli = cliFor(fake.binary);
    const listed = await cli.policyList("sb");
    expect(listed.ok && listed.value.map((r) => r.version)).toEqual([2, 3]);
    expect(await cli.latestLoaded("sb")).toEqual({ ok: true, value: true });
    fake.respond([
      {
        match: ["policy"],
        stdout: CANNED.policyList([
          { version: 4, status: "failed" },
          { version: 3, status: "loaded" },
        ]),
      },
    ]);
    expect(await cli.latestLoaded("sb")).toEqual({ ok: true, value: false });
    fake.respond([{ match: ["policy"], stdout: CANNED.policyList([]) }]);
    expect(await cli.latestLoaded("sb")).toEqual({ ok: true, value: false });
    fake.respond([{ match: ["policy"], stdout: "{}" }]);
    expect((await cli.latestLoaded("sb")).ok).toBe(false);
  });

  test("version", async () => {
    const fake = createFakeOpenShell(join(root, "version"), [
      { match: ["--version"], stdout: "openshell 0.1.2\n" },
    ]);
    expect(await cliFor(fake.binary).version()).toEqual({ ok: true, value: "openshell 0.1.2" });
  });
});
