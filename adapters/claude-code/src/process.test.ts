import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "bun";
import { claudeCodePayloadText } from "../../../tests/fixtures/claude-code/index.ts";
import { selfOf } from "./hook-identity.ts";
import { type HookPort, processPort, runHookProcess, writeAll } from "./process.ts";
import { HOOK_VERSION } from "./version.ts";

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
    managedDir: null,
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

describe("runHookProcess --version (the installer and doctor check it)", () => {
  test("prints the version and exits 0 without reading stdin", async () => {
    const { port, rec } = fakePort(new Promise<string>(() => undefined));
    expect(await runHookProcess(["--version"], [], port)).toBe(0);
    expect(rec.out).toEqual([`${HOOK_VERSION}\n`]);
    expect(rec.exitCodes[0]).toBe(2);
    expect(rec.exits).toEqual([0]);
  });

  test("anything around --version is a bad argument and blocks", async () => {
    const { port, rec } = fakePort(BASH);
    expect(await runHookProcess(["--harness", "claude-code", "--version"], [], port)).toBe(2);
    expect(rec.err.join("")).toContain("blocking (fail closed)");
  });
});

describe("runHookProcess: the fail-closed shell", () => {
  test("the exit code is 2 before anything else, and a fatal error exits 2 with its reason", async () => {
    const { port, rec } = fakePort(new Promise<string>(() => undefined), {
      env: { JEV_COPS_HOOK_DEADLINE_MS: "50" },
    });
    const run = runHookProcess(["--harness", "claude-code"], [], port);
    expect(rec.exitCodes).toEqual([2]);
    rec.fatal?.("hook crashed (boom)");
    expect(rec.err).toEqual(["jev-cops: hook crashed (boom); blocking (fail closed)\n"]);
    expect(rec.exits).toEqual([2]);
    await run;
  });

  test("stdin that never closes: blocked at the deadline", async () => {
    const { port, rec } = fakePort(new Promise<string>(() => undefined), {
      env: { JEV_COPS_HOOK_DEADLINE_MS: "50" },
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
      hookSpecificOutput: { permissionDecision: "deny", permissionDecisionReason: "jev-cops: no" },
    });
    expect(rec.err).toEqual(["jev-cops: no\n"]);
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

  test("a daemon that is down: blocked, and the failure lands in ~/.jev-cops/claude-code-hook.log", async () => {
    const { port, rec, home } = fakePort(BASH);
    const socket = join(tempDir(), "nobody.sock");
    expect(await runHookProcess(["--harness", "claude-code", "--socket", socket], [], port)).toBe(
      2,
    );
    expect(rec.err.join("")).toContain("judge unreachable");
    const log = readFileSync(join(home, ".jev-cops", "claude-code-hook.log"), "utf8");
    expect(log).toContain("PreToolUse sess_abc123 Bash: judge unreachable");
  });

  test("a log that cannot be written is reported on stderr, the outcome unchanged", async () => {
    const { port, rec } = fakePort(BASH, { home: "/dev/null/nowhere" });
    const socket = join(tempDir(), "nobody.sock");
    expect(await runHookProcess(["--harness", "claude-code", "--socket", socket], [], port)).toBe(
      2,
    );
    expect(rec.err.join("")).toContain("jev-cops: local log not written");
  });
});

describe("runHookProcess: ConfigChange reads the settings files on disk", () => {
  function settingsWith(socket: string, entry: boolean): string {
    // This process as a hook: this Bun running this file (`bun <script>` form).
    const self = selfOf([]);
    const handler = {
      type: "command",
      command: self.runtime ?? self.program,
      args: [
        ...(self.runtime === null ? [] : [self.program]),
        ...self.leading,
        "--harness",
        "claude-code",
        "--socket",
        socket,
      ],
    };
    const events = ["PreToolUse", "PostToolUse", "PostToolUseFailure", "UserPromptSubmit"];
    const hooks = Object.fromEntries(
      [...events, ...(entry ? ["ConfigChange"] : [])].map((e) => [e, [{ hooks: [handler] }]]),
    );
    return JSON.stringify({ hooks });
  }

  test.each([
    [true, 0],
    [false, 2],
  ] as const)("jev-cops block complete: %p → exit %d", async (complete, code) => {
    const reports: unknown[] = [];
    const socket = join(tempDir(), "d.sock");
    servers.push(
      Bun.serve({
        unix: socket,
        fetch: async (req) => {
          reports.push(await req.json());
          return Response.json({ ok: true, task: null, killed: false });
        },
      }),
    );
    const project = tempDir();
    mkdirSync(join(project, ".claude"));
    const changed = join(project, ".claude", "settings.json");
    writeFileSync(changed, settingsWith(socket, complete));
    const payload = JSON.stringify({
      session_id: "s1",
      cwd: project,
      hook_event_name: "ConfigChange",
      source: "project_settings",
      file_path: changed,
    });
    const { port, rec } = fakePort(payload, { env: { PATH: process.env.PATH } });
    const argv = ["--harness", "claude-code", "--socket", socket];
    expect(await runHookProcess(argv, [], port)).toBe(code);
    expect(reports).toEqual([expect.objectContaining({ kind: "config-change", intact: complete })]);
    if (!complete) expect(rec.err.join("")).toContain("no cops hook on ConfigChange");
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
