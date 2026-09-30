import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { RunOutcome, RunRequest, Spawn } from "../run.ts";
import { fakeSkillspector, type ScanWorld, scanWorld } from "../testing/fake-binary.ts";
import safe from "../testing/fixtures/safe.json" with { type: "json" };
import type { ScanOptions } from "../types.ts";
import {
  createSkillspectorScanner,
  extraArgsProblem,
  SKILLSPECTOR_LLM_ENV,
  type SkillspectorConfig,
} from "./skillspector.ts";

let world: ScanWorld;
let fake: string;

beforeAll(async () => {
  world = scanWorld();
  fake = await fakeSkillspector();
});
afterAll(() => world.dispose());

const DAEMON_ENV = {
  PATH: "/usr/bin:relative:/bin",
  HOME: "/Users/me",
  LANG: "C.UTF-8",
  TMPDIR: "/var/tmp/",
  ANTHROPIC_API_KEY: "sk-ant-secret",
  SKILLSPECTOR_PROVIDER: "anthropic",
  AWS_SECRET_ACCESS_KEY: "aws-secret",
  DOCKER_HOST: "unix:///var/run/docker.sock",
  UNRELATED: "x",
};

/** A spawn that records every request and answers `outcome`. */
function recording(
  outcome: RunOutcome = { kind: "exit", code: 0, stdout: JSON.stringify(safe), stderrTail: "" },
) {
  const calls: RunRequest[] = [];
  const spawn: Spawn = async (r) => {
    calls.push(r);
    return outcome;
  };
  return { spawn, calls };
}

const which = (found: Record<string, string>) => (name: string) => found[name] ?? null;
const OPTS: ScanOptions = { deadlineMs: 60_000 };

function scanner(config: Omit<SkillspectorConfig, "adapter">, spawn: Spawn) {
  return createSkillspectorScanner(
    { adapter: "skillspector", ...config },
    {
      spawn,
      env: DAEMON_ENV,
      which: which({ skillspector: "/opt/ss/bin/skillspector", docker: "/usr/local/bin/docker" }),
    },
  );
}

describe("skillspector argv and environment (byte-exact)", () => {
  test("static mode: --no-llm, the scrubbed env, the workflow ceiling, cwd = the scanned dir", async () => {
    const { spawn, calls } = recording();
    const dir = world.skill("safe");
    const res = await scanner({}, spawn).scan({ kind: "dir", path: dir }, OPTS);
    expect(res.verdict).toBe("safe");
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({
      argv: ["/opt/ss/bin/skillspector", "scan", dir, "--format", "json", "--no-llm"],
      cwd: dir,
      env: {
        PATH: "/usr/bin:/bin",
        HOME: "/Users/me",
        LANG: "C.UTF-8",
        TMPDIR: "/var/tmp/",
        SKILLSPECTOR_MAX_WORKFLOW_SECONDS: "60",
        SKILLSPECTOR_LOG_LEVEL: "ERROR",
      },
      deadlineMs: 60_000,
    });
  });

  test("llm mode: no --no-llm, and the documented provider variables that are set", async () => {
    const { spawn, calls } = recording({
      kind: "exit",
      code: 0,
      stdout: JSON.stringify({
        ...safe,
        metadata: { ...safe.metadata, llm_requested: true, llm_available: true },
      }),
      stderrTail: "",
    });
    const dir = world.skill("safe");
    const res = await scanner({ mode: "llm" }, spawn).scan({ kind: "dir", path: dir }, OPTS);
    expect(res).toMatchObject({ verdict: "safe", mode: "llm", network: "provider" });
    expect(calls[0]?.argv).toEqual(["/opt/ss/bin/skillspector", "scan", dir, "--format", "json"]);
    expect(calls[0]?.env).toEqual({
      PATH: "/usr/bin:/bin",
      HOME: "/Users/me",
      LANG: "C.UTF-8",
      TMPDIR: "/var/tmp/",
      ANTHROPIC_API_KEY: "sk-ant-secret",
      SKILLSPECTOR_PROVIDER: "anthropic",
      AWS_SECRET_ACCESS_KEY: "aws-secret",
      SKILLSPECTOR_MAX_WORKFLOW_SECONDS: "60",
      SKILLSPECTOR_LOG_LEVEL: "ERROR",
    });
    expect(SKILLSPECTOR_LLM_ENV).toContain("NVIDIA_INFERENCE_KEY");
    expect(SKILLSPECTOR_LLM_ENV).not.toContain("GITHUB_TOKEN");
  });

  test("the workflow ceiling is the deadline rounded up to whole seconds", async () => {
    const { spawn, calls } = recording();
    await scanner({}, spawn).scan(
      { kind: "dir", path: world.skill("safe") },
      { deadlineMs: 1_500 },
    );
    expect(calls[0]?.env.SKILLSPECTOR_MAX_WORKFLOW_SECONDS).toBe("2");
  });

  test("a file target is scanned as is, from its own directory", async () => {
    const { spawn, calls } = recording();
    const file = join(world.skill("safe"), "SKILL.md");
    await scanner({}, spawn).scan({ kind: "file", path: file }, OPTS);
    expect(calls[0]?.argv[2]).toBe(file);
    expect(calls[0]?.cwd).toBe(join(file, ".."));
  });

  test("allowed extra flags are appended; --use-shipped-baseline never is", async () => {
    const { spawn, calls } = recording();
    const yara = world.root;
    const s = scanner({ extraArgs: ["--fail-on-findings", "--yara-rules-dir", yara] }, spawn);
    await s.scan({ kind: "dir", path: world.skill("safe") }, OPTS);
    expect(calls[0]?.argv.slice(6)).toEqual(["--fail-on-findings", "--yara-rules-dir", yara]);
    const bad = recording();
    const refused = scanner({ extraArgs: ["--use-shipped-baseline"] }, bad.spawn);
    const res = await refused.scan({ kind: "dir", path: world.skill("safe") }, OPTS);
    expect(res).toMatchObject({
      verdict: "error",
      error: "extra argument not allowed: --use-shipped-baseline",
    });
    expect(await refused.available()).toEqual({
      ok: false,
      reason: "extra argument not allowed: --use-shipped-baseline",
    });
    expect(bad.calls).toHaveLength(0);
  });
});

describe("extraArgsProblem", () => {
  test.each([
    [["--fail-on-findings", "--fail-on-incomplete", "--recursive", "--transitive"], false, null],
    [["--baseline", "/abs/base.yaml"], false, null],
    [["-b", "/abs/base.yaml", "--yara-rules-dir=/abs/rules"], false, null],
    [["--baseline"], false, "--baseline needs an absolute path"],
    [["--baseline", "rel.yaml"], false, "--baseline needs an absolute path"],
    [["--format", "sarif"], false, "extra argument not allowed: --format"],
    [["-o", "/tmp/x"], false, "extra argument not allowed: -o"],
    [["--no-llm"], false, "extra argument not allowed: --no-llm"],
    [["--use-shipped-baseline"], false, "extra argument not allowed: --use-shipped-baseline"],
    [["--fail-on-findings"], true, null],
    [["--baseline", "/abs/b.yaml"], true, "--baseline is not supported with docker"],
  ] as const)("%p (docker %p) → %p", (args, docker, problem) => {
    expect(extraArgsProblem(args, docker)).toBe(problem);
  });
});

describe("docker form", () => {
  test("mounts the dir read-only at /scan, passes variables by name, never their values", async () => {
    const { spawn, calls } = recording();
    const dir = world.skill("safe");
    const s = scanner({ docker: { image: "skillspector:local" } }, spawn);
    await s.scan({ kind: "dir", path: dir }, OPTS);
    expect(calls[0]?.argv).toEqual([
      "/usr/local/bin/docker",
      "run",
      "--rm",
      "--cap-drop",
      "ALL",
      "--security-opt",
      "no-new-privileges",
      "-v",
      `${dir}:/scan:ro`,
      "-e",
      "SKILLSPECTOR_MAX_WORKFLOW_SECONDS",
      "-e",
      "SKILLSPECTOR_LOG_LEVEL",
      "skillspector:local",
      "scan",
      "/scan",
      "--format",
      "json",
      "--no-llm",
    ]);
    expect(calls[0]?.env).toEqual({
      PATH: "/usr/bin:/bin",
      HOME: "/Users/me",
      LANG: "C.UTF-8",
      TMPDIR: "/var/tmp/",
      DOCKER_HOST: "unix:///var/run/docker.sock",
      SKILLSPECTOR_MAX_WORKFLOW_SECONDS: "60",
      SKILLSPECTOR_LOG_LEVEL: "ERROR",
    });
  });

  test("air-gapped network, llm variables by name, a file mounted through its directory", async () => {
    const { spawn, calls } = recording();
    const file = join(world.skill("safe"), "SKILL.md");
    const s = scanner({ docker: { image: "ss", network: "none" }, mode: "llm" }, spawn);
    await s.scan({ kind: "file", path: file }, OPTS);
    const argv = calls[0]?.argv ?? [];
    expect(argv.slice(3, 5)).toEqual(["--network", "none"]);
    expect(argv).toContain(`${join(file, "..")}:/scan:ro`);
    expect(argv.slice(-4)).toEqual(["scan", "/scan/SKILL.md", "--format", "json"]);
    expect(argv.join(" ")).not.toContain("sk-ant-secret");
    const names = argv.flatMap((a, i) => (argv[i - 1] === "-e" ? [a] : []));
    expect(names).toEqual([
      "SKILLSPECTOR_MAX_WORKFLOW_SECONDS",
      "SKILLSPECTOR_LOG_LEVEL",
      "SKILLSPECTOR_PROVIDER",
      "ANTHROPIC_API_KEY",
      "AWS_SECRET_ACCESS_KEY",
    ]);
  });

  test("finding paths inside the container are shown relative to /scan", async () => {
    const issue = { id: "E1", severity: "HIGH", location: { file: "/scan/scripts/sync.py" } };
    const stdout = JSON.stringify({ ...safe, issues: [issue] });
    const { spawn } = recording({ kind: "exit", code: 0, stdout, stderrTail: "" });
    const res = await scanner({ docker: { image: "ss" } }, spawn).scan(
      { kind: "dir", path: world.skill("safe") },
      OPTS,
    );
    expect(res.findings[0]?.file).toBe("scripts/sync.py");
  });

  test("a directory whose path holds ':' cannot be mounted", async () => {
    const colon = join(world.root, "a:b");
    mkdirSync(colon);
    const { spawn, calls } = recording();
    const res = await scanner({ docker: { image: "ss" } }, spawn).scan(
      { kind: "dir", path: colon },
      OPTS,
    );
    expect(res.verdict).toBe("error");
    expect(calls).toHaveLength(0);
  });

  test("available() asks the image for its version, offline", async () => {
    const { spawn, calls } = recording({
      kind: "exit",
      code: 0,
      stdout: "skillspector, version 2.12.0\n",
      stderrTail: "",
    });
    const s = scanner({ docker: { image: "ss" } }, spawn);
    expect(await s.available()).toEqual({ ok: true, version: "2.12.0" });
    expect(calls[0]?.argv).toEqual([
      "/usr/local/bin/docker",
      "run",
      "--rm",
      "--network",
      "none",
      "ss",
      "--version",
    ]);
  });
});

describe("finding the tool", () => {
  test("not on PATH: available() says so, scan() is an error, nothing runs", async () => {
    const { spawn, calls } = recording();
    const s = createSkillspectorScanner(
      { adapter: "skillspector" },
      { spawn, env: DAEMON_ENV, which: which({}) },
    );
    expect(await s.available()).toEqual({ ok: false, reason: "skillspector not found on PATH" });
    const res = await s.scan({ kind: "dir", path: world.skill("safe") }, OPTS);
    expect(res).toMatchObject({
      verdict: "error",
      error: "skillspector not found on PATH",
      network: "none",
    });
    const docker = createSkillspectorScanner(
      { adapter: "skillspector", docker: { image: "ss" } },
      { spawn, env: DAEMON_ENV, which: which({}) },
    );
    expect(await docker.available()).toEqual({ ok: false, reason: "docker not found on PATH" });
    expect(calls).toHaveLength(0);
  });

  test("a configured binary must be absolute", async () => {
    const { spawn, calls } = recording();
    const s = scanner({ binary: "bin/skillspector" }, spawn);
    expect(await s.available()).toEqual({
      ok: false,
      reason: "skillspector binary must be an absolute path: bin/skillspector",
    });
    expect((await s.scan({ kind: "dir", path: world.skill("safe") }, OPTS)).verdict).toBe("error");
    expect(calls).toHaveLength(0);
  });

  test("the PATH lookup sees only the absolute PATH entries of the daemon's env", async () => {
    const seen: string[] = [];
    const s = createSkillspectorScanner(
      { adapter: "skillspector" },
      {
        env: DAEMON_ENV,
        which: (name, path) => {
          seen.push(`${name}@${path}`);
          return null;
        },
      },
    );
    await s.available();
    expect(seen).toEqual(["skillspector@/usr/bin:/bin"]);
  });
});

describe("with the fake skillspector", () => {
  const real = () =>
    createSkillspectorScanner(
      { adapter: "skillspector", binary: fake },
      { env: { HOME: world.home, PATH: "/usr/bin:/bin" } },
    );

  test("available() reads the version", async () => {
    expect(await real().available()).toEqual({ ok: true, version: "2.12.0" });
  });

  test("a failing --version is not available, with the reason", async () => {
    writeFileSync(join(world.home, "fake-skillspector-version"), "fail");
    try {
      const a = await real().available();
      expect(a.ok).toBe(false);
      expect(a.ok ? "" : a.reason).toContain("skillspector --version exited 1");
    } finally {
      writeFileSync(join(world.home, "fake-skillspector-version"), "2.12.0");
    }
  });

  test("an LLM pass that was requested but did not run is an error, not a clean static scan", async () => {
    const res = await createSkillspectorScanner(
      { adapter: "skillspector", binary: fake, mode: "llm" },
      { env: { HOME: world.home, PATH: "/usr/bin" } },
    ).scan({ kind: "dir", path: world.skill("llm-unavailable") }, OPTS);
    expect(res).toMatchObject({
      verdict: "error",
      error: "LLM analysis was requested but did not run: NVIDIA_INFERENCE_KEY is not set",
      mode: "llm",
    });
  });

  test("an LLM pass in static mode is an error: contents may have left the machine", async () => {
    const res = await real().scan({ kind: "dir", path: world.skill("llm-ran") }, OPTS);
    expect(res).toMatchObject({
      verdict: "error",
      error: "SkillSpector ran an LLM pass although static mode was configured",
      network: "provider",
    });
  });

  test("the report's own version wins; the score is kept as reported", async () => {
    const res = await real().scan({ kind: "dir", path: world.skill("caution") }, OPTS);
    expect(res).toMatchObject({
      verdict: "caution",
      score: 35,
      version: "2.12.0",
      tool: "skillspector",
    });
    expect(res.findings[0]).toMatchObject({ file: "scripts/sync.py", line: 45 });
  });

  test("exit 2 is an error carrying the stderr tail; the error line names the exit", async () => {
    const res = await real().scan({ kind: "dir", path: world.skill("tool-error") }, OPTS);
    expect(res.error).toBe("skillspector exited 2: Error: unreadable source (tool-error)");
    expect(res.stderrTail).toBe("Error: unreadable source (tool-error)\n");
  });
});
