import { describe, expect, test } from "bun:test";
import { spawnProcess } from "./spawn.ts";

const env = { PATH: "/usr/bin:/bin" };

describe("spawnProcess", () => {
  test("captures exit code, stdout and stderr, and feeds stdin", async () => {
    const r = await spawnProcess({
      argv: ["sh", "-c", "cat; echo err >&2; exit 3"],
      env,
      stdin: "in",
      timeoutMs: 5_000,
    });
    expect(r).toEqual({ exitCode: 3, stdout: "in", stderr: "err\n", timedOut: false, error: null });
  });

  test("a command not on PATH is an error, not a throw", async () => {
    const r = await spawnProcess({ argv: ["jev-cops-no-such-cmd"], env, timeoutMs: 1_000 });
    expect(r.exitCode).toBeNull();
    expect(r.error).toContain("not found");
  });

  test("a spawn failure is an error, not a throw", async () => {
    const r = await spawnProcess({ argv: ["/nonexistent/bin"], env, timeoutMs: 1_000 });
    expect(r.exitCode).toBeNull();
    expect(r.error).not.toBeNull();
  });

  test("the timeout kills the process", async () => {
    const r = await spawnProcess({ argv: ["sleep", "5"], env, timeoutMs: 100 });
    expect(r.timedOut).toBe(true);
  });
});
