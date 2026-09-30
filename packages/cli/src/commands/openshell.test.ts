import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { COMPILER_VERSION, parsePolicyYaml } from "@jev-cops/openshell";
import { CANNED, createFakeOpenShell } from "../../../openshell/testing/fake-openshell.ts";
import { captureIo } from "../io.ts";
import { CLI_USAGE, main } from "../main.ts";
import { CLI_VERSION } from "../version.ts";

const POLICIES = join(import.meta.dir, "..", "..", "..", "..", "policies");
const root = mkdtempSync(join(tmpdir(), "jev-cops-openshell-cmd-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const repo = join(root, "repo");
mkdirSync(join(repo, ".git"), { recursive: true });
writeFileSync(join(repo, ".git", "config"), '[remote "origin"]\n\turl = git@github.com:o/r.git\n');
writeFileSync(join(repo, "package-lock.json"), "{}");

const BASE = ["--repo", repo, "--policies", POLICIES];
const TASK = ["--task", "Fix it per https://docs.example.com"];

/** PATH holds no `openshell` during a run: a real one on the test machine is never called. */
const EMPTY_BIN = join(root, "empty-bin");
mkdirSync(EMPTY_BIN);

async function run(...argv: string[]) {
  const io = captureIo();
  const path = process.env.PATH;
  process.env.PATH = EMPTY_BIN;
  try {
    const code = await main(["openshell", ...argv], io);
    return { code, out: io.stdout.join("\n"), err: io.stderr.join("\n") };
  } finally {
    process.env.PATH = path;
  }
}

describe("cops openshell compile", () => {
  test("prints the policy, the report on stderr", async () => {
    const r = await run("compile", ...BASE, ...TASK);
    expect(r.code).toBe(0);
    const parsed = parsePolicyYaml(r.out);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      const remote = parsed.value.network_policies?.jev_cops_task_remote?.endpoints?.[0];
      expect(remote).toEqual({ host: "github.com", port: 22, protocol: "tcp", tls: "skip" });
    }
    expect(r.err).toContain("result: policy emitted");
    expect(r.err).toContain("config-tamper@");
  });

  test("--out writes the file; --dry-run diffs against it and writes nothing", async () => {
    const out = join(root, "policy.yaml");
    expect((await run("compile", ...BASE, "--out", out)).code).toBe(0);
    const before = readFileSync(out, "utf8");
    const same = await run("compile", ...BASE, "--out", out, "--dry-run");
    expect([same.code, same.out]).toEqual([0, `diff against ${out}:\n  no changes`]);
    const changed = await run("compile", ...BASE, ...TASK, "--dry-run", "--against", out);
    expect(changed.code).toBe(3);
    expect(changed.out).toContain("+ rule jev_cops_task_hosts");
    expect(readFileSync(out, "utf8")).toBe(before);
    const fresh = await run("compile", "--no-repo", "--policies", POLICIES, "--dry-run");
    expect([fresh.code, fresh.out.split("\n")[0]]).toEqual([3, "diff against an empty policy:"]);
  });

  test("a refused layout exits 1 with the reason and no policy", async () => {
    const r = await run("compile", ...BASE, "--home", "/sandbox/home");
    expect(r.code).toBe(1);
    expect(r.out).toBe("");
    expect(r.err).toContain("HOME /sandbox/home is inside the read_write workspace");
  });

  test("an invalid --against file exits 1", async () => {
    const bad = join(root, "bad.yaml");
    writeFileSync(bad, "version: 2\n");
    const r = await run("compile", ...BASE, "--dry-run", "--against", bad);
    expect(r.code).toBe(1);
    expect(r.err).toContain("not a valid policy");
  });

  test("usage errors exit 2", async () => {
    expect((await run("compile", "--harness", "codex")).code).toBe(2);
    expect((await run("compile", "--judge-port", "70000", "--no-repo")).code).toBe(2);
    expect((await run("compile", "--frob")).code).toBe(2);
    expect((await run("compile", "extra")).code).toBe(2);
    expect((await run("frob")).code).toBe(2);
    expect((await run()).code).toBe(2);
  });

  test("Pi, extra hosts and layout flags", async () => {
    const r = await run(
      "compile",
      "--harness",
      "pi",
      "--no-repo",
      "--policies",
      POLICIES,
      "--judge-host",
      "llm.corp.example",
      "--interpreter",
      "/usr/bin/node",
      "--agent-binary",
      "/usr/bin/node",
      "--no-judge",
      "--task",
      "read docs.example.com",
    );
    expect(r.code).toBe(0);
    expect(r.err).toContain("llm.corp.example");
    expect(r.out).not.toContain("jev_cops_judge");
    expect(r.out).toContain('path: "/usr/bin/node"');
  });
});

describe("cops openshell apply", () => {
  test("runs one policy update per task host, then checks Loaded", async () => {
    const fake = createFakeOpenShell(join(root, "apply-ok"), [
      { match: ["policy", "list"], stdout: CANNED.policyList([{ version: 4, status: "loaded" }]) },
    ]);
    const r = await run("apply", "sb", ...BASE, ...TASK, "--openshell", fake.binary);
    expect(r.code).toBe(0);
    expect(fake.calls().map((c) => c.argv)).toEqual([
      [
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
      ],
      ["policy", "list", "sb", "--output", "json"],
    ]);
  });

  test("a rejected revision or a revision not Loaded exits 1", async () => {
    const rejected = createFakeOpenShell(join(root, "apply-rejected"), [
      { match: ["policy", "update"], exit: 1, stderr: "rejected" },
    ]);
    const r = await run("apply", "sb", ...BASE, ...TASK, "--openshell", rejected.binary);
    expect([r.code, r.err.includes("rejected (exit 1)")]).toEqual([1, true]);
    const pending = createFakeOpenShell(join(root, "apply-pending"), [
      { match: ["policy", "list"], stdout: CANNED.policyList([{ version: 4, status: "pending" }]) },
    ]);
    const p = await run("apply", "sb", ...BASE, ...TASK, "--openshell", pending.binary);
    expect([p.code, p.err.includes("not Loaded")]).toEqual([1, true]);
  });

  test("no task host: nothing to apply", async () => {
    const fake = createFakeOpenShell(join(root, "apply-none"));
    const r = await run("apply", "sb", ...BASE, "--openshell", fake.binary);
    expect([r.code, r.out]).toEqual([0, "nothing to apply: the task names no host"]);
    expect(fake.calls()).toEqual([]);
  });

  test("--dry-run diffs against policy get --base and applies nothing", async () => {
    const compiled = await run("compile", ...BASE);
    const parsed = parsePolicyYaml(compiled.out);
    const base = parsed.ok ? parsed.value : null;
    const fake = createFakeOpenShell(join(root, "apply-dry"), [
      { match: ["policy", "get"], stdout: CANNED.policyGet(base, 3) },
    ]);
    const r = await run("apply", "sb", ...BASE, ...TASK, "--dry-run", "--openshell", fake.binary);
    expect(r.code).toBe(3);
    expect(r.out).toContain("would run: openshell policy update sb");
    expect(r.out).toContain("+ rule jev_cops_task_hosts");
    expect(fake.calls().map((c) => c.argv[1])).toEqual(["get"]);
    const failing = createFakeOpenShell(join(root, "apply-dry-down"), [{ match: [], exit: 1 }]);
    expect(
      (await run("apply", "sb", ...BASE, "--dry-run", "--openshell", failing.binary)).code,
    ).toBe(1);
  });

  test("without openshell: --dry-run prints, a real apply refuses", async () => {
    const dry = await run("apply", "sb", ...BASE, ...TASK, "--dry-run");
    expect(dry.code).toBe(3);
    expect(dry.out).toContain("openshell not found");
    const none = await run("apply", "sb", ...BASE, "--dry-run");
    expect(none.code).toBe(0);
    const real = await run("apply", "sb", ...BASE, ...TASK);
    expect([real.code, real.err.includes("nothing applied")]).toEqual([1, true]);
    expect((await run("apply", ...BASE)).code).toBe(2);
    expect((await run("apply", "sb", ...BASE, "--openshell", "relative")).code).toBe(1);
    expect((await run("apply", "sb", ...BASE, "--home", "/sandbox/x")).code).toBe(1);
  });
});

describe("cops openshell create", () => {
  const policyOut = join(root, "create-policy.yaml");

  test("--dry-run writes the policy and prints the calls, runs nothing", async () => {
    const r = await run(
      "create",
      "sb",
      ...BASE,
      "--from",
      "img:1",
      "--policy-out",
      policyOut,
      "--dry-run",
    );
    expect(r.code).toBe(0);
    expect(r.out).toContain(`policy: ${policyOut}`);
    expect(r.out).toContain(
      `would run: openshell sandbox create --name sb --from img:1 --policy ${policyOut} --no-auto-providers --approval-mode manual --detach --output json`,
    );
    expect(r.out).toContain(
      "would run: openshell settings set sb --key proposal_approval_mode --value manual",
    );
    expect(parsePolicyYaml(readFileSync(policyOut, "utf8")).ok).toBe(true);
  });

  test("with openshell: creates, pins the advisor", async () => {
    const fake = createFakeOpenShell(join(root, "create-ok"), [
      { match: ["sandbox", "create"], stdout: CANNED.sandboxGet("Ready") },
    ]);
    const r = await run(
      "create",
      "sb",
      ...BASE,
      "--provider",
      "anthropic",
      "--env",
      "CI=1",
      "--openshell",
      fake.binary,
      "--",
      "claude",
    );
    expect(r.code).toBe(0);
    expect(r.out).toContain("created sb: phase Ready, policy revision 3");
    const argv = fake.calls()[0]?.argv ?? [];
    expect(argv.slice(-4)).toEqual(["--output", "json", "--", "claude"]);
    expect(argv).toContain("--provider");
    expect(fake.calls()).toHaveLength(3);
  });

  test("failures: no openshell, create failing, refused, usage", async () => {
    const none = await run("create", "sb", ...BASE);
    expect([none.code, none.err.includes("nothing created")]).toEqual([1, true]);
    const down = createFakeOpenShell(join(root, "create-down"), [
      { match: [], exit: 1, stderr: "no gateway" },
    ]);
    const failed = await run("create", "sb", ...BASE, "--openshell", down.binary);
    expect([failed.code, failed.err.includes("no gateway")]).toEqual([1, true]);
    expect((await run("create", "sb", ...BASE, "--openshell", "relative")).code).toBe(1);
    expect((await run("create", "sb", ...BASE, "--home", "/sandbox/x")).code).toBe(1);
    expect((await run("create", ...BASE)).code).toBe(2);
  });
});

describe("registration", () => {
  test("listed in cops --help; the compiler version follows the CLI's", () => {
    expect(CLI_USAGE).toContain("openshell compile [--dry-run");
    expect(COMPILER_VERSION).toBe(CLI_VERSION);
  });
});
