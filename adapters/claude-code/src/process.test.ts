import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, openSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "bun";
import { claudeCodePayloadText } from "../../../tests/fixtures/claude-code/index.ts";
import { type HookPort, processPort, runHookProcess, selfOf, writeAll } from "./process.ts";

const dirs: string[] = [];
const servers: Server<undefined>[] = [];
afterEach(() => {
  for (const s of servers.splice(0)) s.stop(true);
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "jvcc-p-"));
  dirs.push(dir);
  return dir;
}

/** A port whose writes, exit and fatal handler are recorded instead of acting on this process. */
function fakePort(stdin: string | Promise<string>, over: Partial<HookPort> = {}) {
  const home = tempDir();
  const rec = {
    out: [] as string[],
    err: [] as string[],
    exits: [] as number[],
    exitCodes: [] as number[],
    fatal: null as ((why: string) => void) | null,
  };
  const port: HookPort = {
    env: {},
    home,
    ppid: process.pid,
    readStdin: async () => stdin,
    write: (fd, text) => {
      (fd === 1 ? rec.out : rec.err).push(text);
    },
    exit: (code) => {
      rec.exits.push(code);
    },
    onFatal: (handler) => {
      rec.fatal = handler;
    },
    setExitCode: (code) => {
      rec.exitCodes.push(code);
    },
    ...over,
  };
  return { port, rec, home };
}

function daemon(reply: (body: { id: string }) => unknown): string {
  const unix = join(tempDir(), "d.sock");
  servers.push(
    Bun.serve({
      unix,
      fetch: async (req) => Response.json(reply((await req.json()) as { id: string })),
    }),
  );
  return unix;
}

const BASH = claudeCodePayloadText("pre-tool-use.bash");

describe("runHookProcess: the fail-closed shell", () => {
  test("the exit code is 2 before anything else, and a fatal error exits 2 with its reason", async () => {
    const { port, rec } = fakePort(new Promise<string>(() => undefined), {
      env: { JEVDICT_HOOK_DEADLINE_MS: "50" },
    });
    const run = runHookProcess(["--harness", "claude-code"], [], port);
    expect(rec.exitCodes).toEqual([2]);
    rec.fatal?.("hook crashed (boom)");
    expect(rec.err).toEqual(["jevdict: hook crashed (boom); blocking (fail closed)\n"]);
    expect(rec.exits).toEqual([2]);
    await run;
  });

  test("stdin that never closes: blocked at the deadline", async () => {
    const { port, rec } = fakePort(new Promise<string>(() => undefined), {
      env: { JEVDICT_HOOK_DEADLINE_MS: "50" },
    });
    expect(await runHookProcess(["--harness", "claude-code"], [], port)).toBe(2);
    expect(rec.err.join("")).toContain("unreadable hook payload (stdin not closed)");
    expect(rec.exits).toEqual([2]);
  });

  test.each([
    [["--harness", "pi"], "pi is not a hook harness"],
    [["--socket", "x"], "--harness claude-code is required"],
  ])("arguments %p: exit 2 (%s)", async (argv, message) => {
    const { port, rec } = fakePort(BASH);
    expect(await runHookProcess(argv, [], port)).toBe(2);
    expect(rec.err.join("")).toContain(message);
  });

  test("a verdict is written to stdout and ends the process with its exit code", async () => {
    const socket = daemon((e) => ({ event_id: e.id, verdict: "deny", reason: "no" }));
    const { port, rec } = fakePort(BASH);
    expect(await runHookProcess(["--harness", "claude-code", "--socket", socket], [], port)).toBe(
      2,
    );
    expect(JSON.parse(rec.out.join(""))).toMatchObject({
      hookSpecificOutput: { permissionDecision: "deny", permissionDecisionReason: "jevdict: no" },
    });
    expect(rec.err).toEqual(["jevdict: no\n"]);
    expect(rec.exits).toEqual([2]);
  });

  test("allow writes nothing and exits 0", async () => {
    const socket = daemon((e) => ({ event_id: e.id, verdict: "allow", reason: "ok" }));
    const { port, rec } = fakePort(BASH);
    expect(await runHookProcess(["--harness", "claude-code", "--socket", socket], [], port)).toBe(
      0,
    );
    expect(rec).toMatchObject({ out: [], err: [], exits: [0] });
  });

  test("a daemon that is down: blocked, and the failure lands in ~/.jevdict/claude-code-hook.log", async () => {
    const { port, rec, home } = fakePort(BASH);
    const socket = join(tempDir(), "nobody.sock");
    expect(await runHookProcess(["--harness", "claude-code", "--socket", socket], [], port)).toBe(
      2,
    );
    expect(rec.err.join("")).toContain("judge unreachable");
    const log = readFileSync(join(home, ".jevdict", "claude-code-hook.log"), "utf8");
    expect(log).toContain("PreToolUse sess_abc123 Bash: judge unreachable");
  });

  test("a log that cannot be written is reported on stderr, the outcome unchanged", async () => {
    const { port, rec } = fakePort(BASH, { home: "/dev/null/nowhere" });
    const socket = join(tempDir(), "nobody.sock");
    expect(await runHookProcess(["--harness", "claude-code", "--socket", socket], [], port)).toBe(
      2,
    );
    expect(rec.err.join("")).toContain("jevdict: local log not written");
  });
});

describe("processPort: the real process", () => {
  test("reads this process's environment, home and parent", () => {
    const port = processPort();
    expect(port.env).toBe(process.env);
    expect(port.ppid).toBe(process.ppid);
    expect(port.home.length).toBeGreaterThan(0);
    const before = process.exitCode;
    port.setExitCode(0);
    expect(process.exitCode).toBe(0);
    process.exitCode = before;
    port.write(2, "");
  });
});

describe("writeAll", () => {
  test("writes every byte synchronously (no truncation when the process exits right after)", () => {
    const path = join(tempDir(), "out");
    const fd = openSync(path, "w");
    const text = `${"x".repeat(200_000)}é`;
    writeAll(fd, text);
    expect(readFileSync(path, "utf8")).toBe(text);
  });
});

describe("selfOf: how this process was started, for the ConfigChange identity check", () => {
  test("from source: bun plus the entry script", () => {
    expect(selfOf(["hook"], { execPath: "/usr/bin/bun", main: "/repo/cli/main.ts" })).toEqual({
      command: "/usr/bin/bun",
      leading: ["/repo/cli/main.ts", "hook"],
    });
  });

  test("compiled: the binary alone", () => {
    expect(
      selfOf([], { execPath: "/opt/jevdict-hook", main: "/$bunfs/root/jevdict-hook" }),
    ).toEqual({ command: "/opt/jevdict-hook", leading: [] });
  });
});
