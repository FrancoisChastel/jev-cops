import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { RunOutcome, RunRequest, Spawn } from "../run.ts";
import { type ScanWorld, scanWorld } from "../testing/fake-binary.ts";
import type { ScanNetwork } from "../types.ts";
import { type CommandConfig, createCommandScanner } from "./command.ts";

let world: ScanWorld;
beforeAll(() => {
  world = scanWorld();
});
afterAll(() => world.dispose());

const DAEMON_ENV = {
  PATH: "/usr/bin:rel:/opt/tools/bin",
  HOME: "/Users/me",
  ANTHROPIC_API_KEY: "sk-ant-secret",
  OPENAI_API_KEY: "sk-openai",
};

const doc = (extra: Record<string, unknown>) =>
  JSON.stringify({ schema: "jev-cops.scan/1", verdict: "safe", ...extra });

function recording(stdout: string, code = 0) {
  const calls: RunRequest[] = [];
  const outcome: RunOutcome = { kind: "exit", code, stdout, stderrTail: "" };
  const spawn: Spawn = async (r) => {
    calls.push(r);
    return outcome;
  };
  return { spawn, calls };
}

function scanner(c: Omit<CommandConfig, "adapter">, spawn: Spawn, found: string | null = null) {
  return createCommandScanner(
    { adapter: "command", ...c },
    { spawn, env: DAEMON_ENV, which: () => found },
  );
}

const OPTS = { deadlineMs: 30_000 };

describe("command adapter", () => {
  test("runs argv + [path] in the scanned dir with the base environment only, even in llm mode", async () => {
    const { spawn, calls } = recording(doc({}));
    const dir = world.skill("safe");
    const res = await scanner({ argv: ["/opt/scan/bin/wrap", "--json"], mode: "llm" }, spawn).scan(
      { kind: "dir", path: dir },
      OPTS,
    );
    expect(res).toMatchObject({ verdict: "safe", tool: "wrap", mode: "llm" });
    expect(calls[0]).toEqual({
      argv: ["/opt/scan/bin/wrap", "--json", dir],
      cwd: dir,
      env: { PATH: "/usr/bin:/opt/tools/bin", HOME: "/Users/me" },
      deadlineMs: 30_000,
    });
  });

  test("a bare name is looked up on the absolute PATH entries; a relative path is refused", async () => {
    const seen: string[] = [];
    const { spawn, calls } = recording(doc({}));
    const s = createCommandScanner(
      { adapter: "command", argv: ["my-scanner"] },
      {
        spawn,
        env: DAEMON_ENV,
        which: (name, path) => {
          seen.push(`${name}@${path}`);
          return "/opt/tools/bin/my-scanner";
        },
      },
    );
    await s.scan({ kind: "dir", path: world.skill("safe") }, OPTS);
    expect(seen).toEqual(["my-scanner@/usr/bin:/opt/tools/bin"]);
    expect(calls[0]?.argv[0]).toBe("/opt/tools/bin/my-scanner");
    for (const argv of [["bin/scan"], [], [" "]]) {
      const r = await scanner({ argv }, spawn).scan(
        { kind: "dir", path: world.skill("safe") },
        OPTS,
      );
      expect(r.verdict).toBe("error");
    }
    expect(calls).toHaveLength(1);
    const missing = await scanner({ argv: ["nope"] }, spawn).available();
    expect(missing).toEqual({ ok: false, reason: "nope not found on PATH" });
  });

  test("the exit code is ignored: the document decides", async () => {
    const { spawn } = recording(doc({ verdict: "unsafe", score: 90 }), 7);
    const r = await scanner({ argv: ["/x/scan"] }, spawn).scan(
      { kind: "dir", path: world.skill("x") },
      OPTS,
    );
    expect(r).toMatchObject({ verdict: "unsafe", score: 90 });
  });

  test("a document without a verdict is unreadable", async () => {
    const { spawn } = recording(JSON.stringify({ schema: "jev-cops.scan/1" }));
    const r = await scanner({ argv: ["/x/scan"] }, spawn).scan(
      { kind: "dir", path: world.skill("x") },
      OPTS,
    );
    expect(r).toMatchObject({ verdict: "error", error: "unreadable scanner output" });
  });

  test("tool and version come from the document; a bare error verdict gets a default line", async () => {
    const named = recording(doc({ tool: "cisco-skill-scanner", version: "2.1.0" }));
    const r = await scanner({ argv: ["/x/wrap"] }, named.spawn).scan(
      { kind: "dir", path: world.skill("x") },
      OPTS,
    );
    expect(r).toMatchObject({ tool: "cisco-skill-scanner", version: "2.1.0" });
    const bare = recording(doc({ verdict: "error" }));
    const e = await scanner({ argv: ["/x/wrap"] }, bare.spawn).scan(
      { kind: "dir", path: world.skill("x") },
      OPTS,
    );
    expect(e).toMatchObject({
      verdict: "error",
      error: "the scanner reported an error",
      tool: "wrap",
    });
  });

  test.each([
    [undefined, undefined, "provider"],
    [undefined, "none", "provider"],
    ["none", undefined, "none"],
    ["none", "osv-only", "osv-only"],
    ["osv-only", "none", "osv-only"],
    ["osv-only", "provider", "provider"],
  ] as const)("network: config %p, tool says %p → %p", async (configured, reported, expected) => {
    const { spawn } = recording(doc(reported === undefined ? {} : { network: reported }));
    const c = configured === undefined ? {} : { network: configured as ScanNetwork };
    const r = await scanner({ argv: ["/x/scan"], ...c }, spawn).scan(
      { kind: "dir", path: world.skill("x") },
      OPTS,
    );
    expect(r.network).toBe(expected);
  });

  test("available(): an executable file is ok; a directory or a plain file is not", async () => {
    const exe = join(world.root, "scan-ok");
    writeFileSync(exe, "#!/bin/sh\n");
    chmodSync(exe, 0o755);
    const plain = join(world.root, "scan-plain");
    writeFileSync(plain, "");
    const { spawn } = recording(doc({}));
    expect(await scanner({ argv: [exe] }, spawn).available()).toEqual({ ok: true, version: null });
    expect(await scanner({ argv: [plain] }, spawn).available()).toEqual({
      ok: false,
      reason: `${plain} is missing or not executable`,
    });
    expect(await scanner({ argv: [world.root] }, spawn).available()).toEqual({
      ok: false,
      reason: `${world.root} is not a file`,
    });
  });
});
