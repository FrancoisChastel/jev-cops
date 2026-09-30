/**
 * `cops install claude-code` end to end in a temp world: the real hook (from source) as the
 * registered binary, a real copsd with the repo's policies for the canary, a fake `claude`
 * on PATH. Every write is confined to the temp root (install-world.ts) and checked after.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isUnder } from "../../../../adapters/claude-code/testing/fs-guard.ts";
import { startTestDaemon, type TestDaemon } from "../../../daemon/src/testing/daemon.ts";
import { captureIo } from "../io.ts";
import { type InstallWorld, installWorld } from "../testing/install-world.ts";
import { runInstallCommand } from "./install.ts";

const REPO_POLICIES = join(import.meta.dir, "..", "..", "..", "..", "policies");
let enforce: TestDaemon;
let observe: TestDaemon;
let w: InstallWorld;

beforeAll(async () => {
  enforce = await startTestDaemon({ policies: {}, policiesDir: REPO_POLICIES, mode: "enforce" });
  observe = await startTestDaemon({ policies: {}, policiesDir: REPO_POLICIES, mode: "observe" });
}, 30_000);
afterAll(async () => {
  await enforce.stop();
  await observe.stop();
});
beforeEach(() => {
  w = installWorld();
});
afterEach(() => {
  for (const p of w.fs.written) expect(isUnder(p, [w.root])).toBe(true);
  w.dispose();
});

type Json = Record<string, unknown>;
const settingsPath = () => join(w.home, ".claude", "settings.json");
const tomlPath = () => join(w.home, ".config", "jev-cops", "cops.toml");
const statePath = () => join(w.home, ".jev-cops", "claude-code.json");
const readJson = (p: string) => JSON.parse(readFileSync(p, "utf8")) as Json;

async function install(args: string[], socket = enforce.config.daemon.socket, over = {}) {
  const io = captureIo();
  const argv = [
    "claude-code",
    "--home",
    w.home,
    "--hook-binary",
    w.hook,
    "--socket",
    socket,
    ...args,
  ];
  const code = await runInstallCommand(argv, io, w.ctx(over));
  return { code, out: io.stdout.join("\n"), err: io.stderr.join("\n"), io };
}

function writeJson(path: string, value: Json): string {
  mkdirSync(join(path, ".."), { recursive: true });
  const text = `${JSON.stringify(value, null, 2)}\n`;
  writeFileSync(path, text);
  return text;
}

describe("cops install claude-code: user scope, enforce daemon", () => {
  test("writes settings, cops.toml and state; the canary passes; gaps printed", async () => {
    const r = await install([]);
    expect(r.code).toBe(0);
    expect(r.out).toContain(`Claude Code hooks installed in ${settingsPath()} (user scope)`);
    expect(r.out).toContain("canary ok");
    expect(r.out).toContain("known gaps");
    expect(r.out).toContain("Without OpenShell, every deny is best-effort");
    const hooks = readJson(settingsPath()).hooks as Record<string, Json[]>;
    expect(hooks.PreToolUse?.[0]).toEqual({
      hooks: [
        {
          type: "command",
          command: w.hook,
          args: ["--harness", "claude-code", "--socket", enforce.config.daemon.socket],
          timeout: 30,
        },
      ],
    });
    expect(Bun.TOML.parse(readFileSync(tomlPath(), "utf8"))).toEqual({
      daemon: { hook_binary: w.hook },
    });
    expect(readJson(statePath())).toEqual({
      claude_version: "2.1.285",
      installed_at: "2026-09-29T09:12:00.000Z",
      scope: "user",
      settings_path: settingsPath(),
      hook_binary: w.hook,
      socket: enforce.config.daemon.socket,
    });
  }, 30_000);

  test("a second run is a no-op that still runs the canary", async () => {
    await install([]);
    const text = readFileSync(settingsPath(), "utf8");
    const r = await install([]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("already installed");
    expect(r.out).toContain("already recorded [daemon] hook_binary");
    expect(r.out).toContain("canary ok");
    expect(readFileSync(settingsPath(), "utf8")).toBe(text);
  }, 30_000);

  test("--json: one object with the settings, the canary and the exit code", async () => {
    const r = await install(["--json"]);
    const report = JSON.parse(r.out) as Json;
    expect(report).toMatchObject({ harness: "claude-code", ok: true, exitCode: 0, scope: "user" });
    expect(report.canary).toMatchObject({ status: "ok" });
    expect(report.settings).toMatchObject({ status: "installed", path: settingsPath() });
  }, 30_000);

  test("--dry-run writes nothing and prints the diff", async () => {
    const r = await install(["--dry-run"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("dry run, nothing written");
    expect(r.out).toContain(`+++ ${settingsPath()}`);
    expect(r.out).toContain("would record [daemon] hook_binary");
    expect(existsSync(join(w.home, ".claude"))).toBe(false);
    expect(existsSync(tomlPath())).toBe(false);
    expect(w.fs.written).toEqual([]);
  }, 30_000);

  test("--uninstall removes only jev-cops's entries and the state file", async () => {
    const original = writeJson(settingsPath(), {
      hooks: { Stop: [{ hooks: [{ type: "command", command: "/x" }] }] },
    });
    await install([]);
    const r = await install(["--uninstall"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain(`jev-cops hooks removed from ${settingsPath()}`);
    expect(readFileSync(settingsPath(), "utf8")).toBe(original);
    expect(existsSync(statePath())).toBe(false);
    const again = await install(["--uninstall"]);
    expect(again.out).toContain("no jev-cops hooks in");
  }, 30_000);
});

describe("cops install claude-code: the canary's other answers", () => {
  test("daemon not reachable: installed, with the fail-closed warning (exit 0)", async () => {
    const r = await install([], join(w.root, "none.sock"));
    expect(r.code).toBe(0);
    expect(r.out).toContain(
      "warning: daemon not reachable: the hook will block every non-read call until copsd runs (fail closed)",
    );
    expect(existsSync(settingsPath())).toBe(true);
  }, 30_000);

  test("observe daemon: installed and reported", async () => {
    const r = await install([], observe.config.daemon.socket);
    expect(r.code).toBe(0);
    expect(r.out).toContain("canary observe");
  }, 30_000);

  test("a hook that lets everything through: exit 1, every write rolled back", async () => {
    const original = writeJson(settingsPath(), { model: "opus" });
    writeJson(join(w.home, ".jev-cops", "claude-code.json"), { claude_version: "2.1.0" });
    const stateBefore = readFileSync(statePath(), "utf8");
    const liar = w.script(
      "liar-hook",
      'if [ "$1" = --version ]; then echo 0.0.0; exit 0; fi\ncat >/dev/null',
    );
    const io = captureIo();
    const argv = [
      "claude-code",
      "--home",
      w.home,
      "--hook-binary",
      liar,
      "--socket",
      enforce.config.daemon.socket,
    ];
    expect(await runInstallCommand(argv, io, w.ctx())).toBe(1);
    expect(io.stderr.join("\n")).toContain("the gate is not in force");
    expect(io.stdout.join("\n")).toContain("rolled back");
    expect(readFileSync(settingsPath(), "utf8")).toBe(original);
    expect(existsSync(tomlPath())).toBe(false);
    expect(readFileSync(statePath(), "utf8")).toBe(stateBefore);
  }, 30_000);
});

describe("cops install claude-code: refusals", () => {
  test("a bare Bash allow refuses (exit 1, nothing written); --force installs and records it", async () => {
    writeJson(settingsPath(), { permissions: { allow: ["Bash"] } });
    const refused = await install([]);
    expect(refused.code).toBe(1);
    expect(refused.out).toContain("refused to install");
    expect(refused.out).toContain("--force");
    expect(existsSync(tomlPath())).toBe(false);
    const forced = await install(["--force"]);
    expect(forced.code).toBe(0);
    expect(forced.out).toContain("warning: FORCED:");
  }, 30_000);

  test("disableAllHooks refuses", async () => {
    writeJson(join(w.project, ".claude", "settings.json"), { disableAllHooks: true });
    expect((await install([])).code).toBe(1);
  });

  test.each([
    ["missing", () => join(w.bin, "gone"), "does not exist"],
    [
      "not executable",
      () => {
        const p = join(w.bin, "plain");
        writeFileSync(p, "#!/bin/sh\n");
        return p;
      },
      "not executable",
    ],
    ["of another version", () => w.script("old-hook", "echo 9.9.9"), "--version is 9.9.9"],
  ])("a hook binary that is %s fails (the gate would be silently off)", async (_why, bin, msg) => {
    const io = captureIo();
    const argv = [
      "claude-code",
      "--home",
      w.home,
      "--hook-binary",
      bin(),
      "--socket",
      enforce.config.daemon.socket,
    ];
    expect(await runInstallCommand(argv, io, w.ctx())).toBe(1);
    expect(io.stderr.join("\n")).toContain(msg);
    expect(existsSync(settingsPath())).toBe(false);
  });

  test("an invalid settings file fails without touching it", async () => {
    mkdirSync(join(w.home, ".claude"));
    writeFileSync(settingsPath(), "{,}");
    const r = await install([]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("not a valid settings file");
    expect(readFileSync(settingsPath(), "utf8")).toBe("{,}");
  });

  test("an invalid cops.toml fails before anything is written", async () => {
    mkdirSync(join(w.home, ".config", "jev-cops"), { recursive: true });
    writeFileSync(tomlPath(), "= = =\n");
    const r = await install([]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("cannot read the jev-cops config");
    writeFileSync(tomlPath(), "[judge]\nprovider = 3\n");
    expect((await install([])).err).toContain("invalid config");
  });

  test("a cops.toml that cannot be edited safely: settings rolled back", async () => {
    mkdirSync(join(w.home, ".config", "jev-cops"), { recursive: true });
    writeFileSync(tomlPath(), "daemon.judge_deadline_ms = 12000\n");
    const r = await install([]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("edit it by hand");
    expect(existsSync(settingsPath())).toBe(false);
  }, 30_000);
});

describe("cops install claude-code: other scopes and transports", () => {
  test("--managed without root prints the drop-in and exits 1", async () => {
    const r = await install(["--managed"]);
    expect(r.code).toBe(1);
    expect(r.out).toContain("not root");
    expect(r.out).toContain('"PreToolUse"');
    expect(existsSync(join(w.managed, "managed-settings.d"))).toBe(false);
  });

  test("--managed as root writes the drop-in and warns about a user-owned binary", async () => {
    const r = await install(["--managed"], enforce.config.daemon.socket, { isRoot: true });
    expect(r.code).toBe(0);
    expect(existsSync(join(w.managed, "managed-settings.d", "50-jev-cops.json"))).toBe(true);
    expect(r.out).toContain("is not root-owned");
    expect(r.out).toContain("first-wins");
  }, 30_000);

  test("--project and --local", async () => {
    expect((await install(["--project"])).code).toBe(0);
    expect(existsSync(join(w.project, ".claude", "settings.json"))).toBe(true);
    expect((await install(["--local"])).code).toBe(0);
    expect(existsSync(join(w.project, ".claude", "settings.local.json"))).toBe(true);
  }, 30_000);

  test("--transport http needs [daemon] http; with it, post events go over HTTP", async () => {
    const refused = await install(["--transport", "http"]);
    expect(refused.code).toBe(1);
    expect(refused.out).toContain("[daemon] http");
    mkdirSync(join(w.home, ".config", "jev-cops"), { recursive: true });
    writeFileSync(tomlPath(), '[daemon]\nhttp = "127.0.0.1:8787"\n');
    const r = await install(["--transport", "http"]);
    expect(r.code).toBe(0);
    const hooks = readJson(settingsPath()).hooks as Record<string, Json[]>;
    expect(hooks.PostToolUse?.[0]).toEqual({
      hooks: [{ type: "http", url: "http://127.0.0.1:8787/v1/hooks/claude-code", timeout: 15 }],
    });
    const toml = Bun.TOML.parse(readFileSync(tomlPath(), "utf8")) as { daemon: Json };
    expect(toml.daemon).toEqual({ http: "127.0.0.1:8787", hook_binary: w.hook });
  }, 30_000);

  test("--home ignores a CLAUDE_CONFIG_DIR outside it", async () => {
    const r = await install([], enforce.config.daemon.socket, {
      env: { PATH: `${w.bin}:/usr/bin:/bin`, CLAUDE_CONFIG_DIR: "/somewhere/real/.claude" },
    });
    expect(r.out).toContain("ignored $CLAUDE_CONFIG_DIR");
    expect(existsSync(settingsPath())).toBe(true);
  }, 30_000);

  test("the default hook binary is the cops-hook next to cops", async () => {
    const io = captureIo();
    const ctx = w.ctx({ runtime: { execPath: join(w.bin, "cops"), main: "/$bunfs/root/cops" } });
    const argv = [
      "claude-code",
      "--home",
      w.home,
      "--socket",
      enforce.config.daemon.socket,
      "--dry-run",
    ];
    expect(await runInstallCommand(argv, io, ctx)).toBe(0);
    expect(io.stdout.join("\n")).toContain(`hook ${w.hook} (version 0.0.0)`);
  });

  test("no hook binary anywhere", async () => {
    const io = captureIo();
    const ctx = w.ctx({ env: { PATH: "/usr/bin:/bin" } });
    const argv = ["claude-code", "--home", w.home, "--dry-run"];
    expect(await runInstallCommand(argv, io, ctx)).toBe(1);
    expect(io.stderr.join("\n")).toContain("no cops-hook found");
  });
});

describe("cops install: usage", () => {
  test.each([
    [[]],
    [["codex"]],
    [["claude-code", "--user", "--local"]],
    [["claude-code", "--transport", "smoke"]],
    [["claude-code", "--nope"]],
    [["pi", "--global", "--project"]],
  ])("%p exits 2", async (argv) => {
    const io = captureIo();
    expect(await runInstallCommand(argv, io, w.ctx())).toBe(2);
    expect(io.stderr.join("\n")).toContain("Usage:");
  });
});
