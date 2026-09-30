import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MAX_STDOUT_BYTES,
  type RunOutcome,
  runBounded,
  STDERR_TAIL_BYTES,
  scanEnv,
} from "./run.ts";

let dir: string;

function script(name: string, body: string): string {
  const path = join(dir, name);
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o755);
  return path;
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Polls until `pid` is gone (a SIGKILLed child is reaped by init shortly after). */
async function gone(pid: number): Promise<boolean> {
  for (let i = 0; i < 50; i++) {
    if (!alive(pid)) return true;
    await Bun.sleep(20);
  }
  return false;
}

const ENV = { PATH: "/usr/bin:/bin", HOME: "/nonexistent" };

beforeAll(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "jvscan-run-")));
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("runBounded", () => {
  test("runs argv in exec form, in cwd, with exactly the given environment", async () => {
    const bin = script("show", 'pwd; env | sort; printf "%s|" "$@"');
    const out = await runBounded({
      argv: [bin, "a b", "$HOME", "; rm -rf /"],
      cwd: dir,
      env: { ...ENV, ONLY: "1" },
      deadlineMs: 5_000,
    });
    expect(out.kind).toBe("exit");
    if (out.kind !== "exit") return;
    expect(out.code).toBe(0);
    const [cwd, ...rest] = out.stdout.split("\n");
    expect(cwd).toBe(dir);
    const vars = rest.filter((l) => /^[A-Z_]+=/.test(l)).map((l) => l.split("=")[0]);
    expect(vars.filter((v) => !["PWD", "SHLVL", "_", "OLDPWD"].includes(v ?? ""))).toEqual([
      "HOME",
      "ONLY",
      "PATH",
    ]);
    expect(out.stdout.endsWith("a b|$HOME|; rm -rf /|")).toBe(true);
  });

  test("a non-zero exit is an exit, with stdout and the stderr tail", async () => {
    const bin = script("fail", 'echo out; echo "went wrong" >&2; exit 2');
    const out = await runBounded({ argv: [bin], cwd: dir, env: ENV, deadlineMs: 5_000 });
    expect(out).toEqual({ kind: "exit", code: 2, stdout: "out\n", stderrTail: "went wrong\n" });
  });

  test("keeps only the last 2 KB of stderr", async () => {
    const bin = script("noisy", `head -c 5000 /dev/zero | tr '\\0' a >&2; printf END >&2`);
    const out = await runBounded({ argv: [bin], cwd: dir, env: ENV, deadlineMs: 5_000 });
    expect(out.kind).toBe("exit");
    if (out.kind !== "exit") return;
    expect(out.stderrTail).toHaveLength(STDERR_TAIL_BYTES);
    expect(out.stderrTail.endsWith("aaaEND")).toBe(true);
  });

  test("a relative or missing binary never runs", async () => {
    for (const argv of [["skillspector"], ["./x"], [join(dir, "missing")], []]) {
      const out = await runBounded({ argv, cwd: dir, env: ENV, deadlineMs: 1_000 });
      expect(out.kind).toBe("spawn-error");
    }
  });

  test("at the deadline the whole process group is killed: timeout", async () => {
    const pidFile = join(dir, "child.pid");
    const bin = script("hang", `sleep 30 & echo $! > "${pidFile}"; wait`);
    const started = performance.now();
    const out = await runBounded({ argv: [bin], cwd: dir, env: ENV, deadlineMs: 400 });
    expect(out.kind).toBe("timeout");
    expect(performance.now() - started).toBeLessThan(2_000);
    const child = Number(readFileSync(pidFile, "utf8"));
    expect(await gone(child)).toBe(true);
  });

  test("a child left behind after a normal exit is killed with its group", async () => {
    const pidFile = join(dir, "orphan.pid");
    const bin = script("orphan", `sleep 30 >/dev/null 2>&1 & echo $! > "${pidFile}"; echo done`);
    const out = await runBounded({ argv: [bin], cwd: dir, env: ENV, deadlineMs: 5_000 });
    expect(out).toMatchObject({ kind: "exit", code: 0, stdout: "done\n" });
    expect(await gone(Number(readFileSync(pidFile, "utf8")))).toBe(true);
  });

  test("a grandchild that keeps stdout open is killed, and the exit still counts", async () => {
    const bin = script("holder", "sleep 30 & echo result");
    const started = performance.now();
    const out = await runBounded({ argv: [bin], cwd: dir, env: ENV, deadlineMs: 3_000 });
    expect(out).toMatchObject({ kind: "exit", code: 0, stdout: "result\n" });
    expect(performance.now() - started).toBeLessThan(2_000);
  });

  test("stdout over the cap is an overflow and the process is killed", async () => {
    const bin = script("flood", "while :; do echo xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx; done");
    const out = await runBounded({
      argv: [bin],
      cwd: dir,
      env: ENV,
      deadlineMs: 5_000,
      maxStdoutBytes: 4096,
    });
    expect(out.kind).toBe("overflow");
  });

  test("the default stdout cap is 4 MiB", () => {
    expect(MAX_STDOUT_BYTES).toBe(4 * 1024 * 1024);
  });

  test("an abort kills the scan; an aborted signal runs nothing", async () => {
    const bin = script("slow", "sleep 30");
    const ctrl = new AbortController();
    setTimeout(() => ctrl.abort(), 100);
    const out = await runBounded({
      argv: [bin],
      cwd: dir,
      env: ENV,
      deadlineMs: 10_000,
      signal: ctrl.signal,
    });
    expect(out.kind).toBe("aborted");
    const marker = join(dir, "ran");
    const never = script("never", `touch "${marker}"`);
    const again: RunOutcome = await runBounded({
      argv: [never],
      cwd: dir,
      env: ENV,
      deadlineMs: 1_000,
      signal: AbortSignal.abort(),
    });
    expect(again.kind).toBe("aborted");
    expect(() => readFileSync(marker)).toThrow();
  });
});

describe("scanEnv", () => {
  const daemon = {
    PATH: "./bin:/usr/bin::relative:/opt/homebrew/bin",
    HOME: "/Users/me",
    LANG: "en_US.UTF-8",
    TMPDIR: "/var/folders/x/T/",
    AWS_SECRET_ACCESS_KEY: "secret",
    SKILLSPECTOR_PROVIDER: "anthropic",
    ANTHROPIC_API_KEY: "sk-ant",
    GIT_DIR: "/elsewhere",
  };

  test("keeps PATH (absolute entries only), HOME, LANG and TMPDIR; drops the rest", () => {
    expect(scanEnv(daemon)).toEqual({
      PATH: "/usr/bin:/opt/homebrew/bin",
      HOME: "/Users/me",
      LANG: "en_US.UTF-8",
      TMPDIR: "/var/folders/x/T/",
    });
  });

  test("named variables pass when set; extras are added last", () => {
    expect(
      scanEnv(daemon, ["ANTHROPIC_API_KEY", "OPENAI_API_KEY"], { SKILLSPECTOR_LOG_LEVEL: "ERROR" }),
    ).toEqual({
      PATH: "/usr/bin:/opt/homebrew/bin",
      HOME: "/Users/me",
      LANG: "en_US.UTF-8",
      TMPDIR: "/var/folders/x/T/",
      ANTHROPIC_API_KEY: "sk-ant",
      SKILLSPECTOR_LOG_LEVEL: "ERROR",
    });
  });

  test("an empty environment gives an empty PATH, nothing else", () => {
    expect(scanEnv({})).toEqual({ PATH: "" });
  });
});
