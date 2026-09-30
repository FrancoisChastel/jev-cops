import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { captureIo } from "../io.ts";
import { type ServiceWorld, serviceWorld } from "../service/testing.ts";
import { runServiceCommand, SERVICE_USAGE } from "./service.ts";

let w: ServiceWorld;
beforeEach(() => {
  w = serviceWorld();
});
afterEach(() => w.dispose());

const L = "/bin/launchctl";
const S = "/usr/bin/systemctl";
const RUNNING = "gui/501/dev.jev-cops.copsd = {\n\tstate = running\n\tpid = 4123\n}";

async function cops(argv: string[], over: Parameters<ServiceWorld["factory"]>[0] = {}) {
  const io = captureIo();
  const code = await runServiceCommand(argv, io, w.factory(over));
  return { code, out: io.stdout.join("\n"), err: io.stderr.join("\n") };
}

describe("cops service status", () => {
  test("installed, up to date and running: exit 0, a digest, launchctl print only", async () => {
    await cops(["install"]);
    w.calls.length = 0;
    w.respond("print", { code: 0, stdout: RUNNING });
    const r = await cops(["status"]);
    expect(r.code).toBe(0);
    expect(w.calls).toEqual([[L, "print", "gui/501/dev.jev-cops.copsd"]]);
    expect(r.out).toContain(
      "copsd service (launchd user agent dev.jev-cops.copsd): running, pid 4123",
    );
    expect(r.out).toContain("(installed, up to date)");
    expect(r.out).toContain(`program  ${w.copsd} (compiled)`);
  });

  test("a unit that differs from what install writes now is named", async () => {
    await cops(["install"]);
    writeFileSync(join(w.home, "Library", "LaunchAgents", "dev.jev-cops.copsd.plist"), "<old/>");
    w.respond("print", { code: 0, stdout: RUNNING });
    const r = await cops(["status"]);
    expect(r.out).toContain("differs from what `cops service install` writes now");
  });

  test("not installed, or installed but not loaded: exit 1", async () => {
    w.respond("print", { code: 113, stdout: "Could not find service" });
    const none = await cops(["status"]);
    expect(none.code).toBe(1);
    expect(none.out).toContain("(not installed)");
    await cops(["install"]);
    const idle = await cops(["status"]);
    expect(idle.code).toBe(1);
    expect(idle.out).toContain("state    not loaded");
  });

  test("loaded but crashed: the last exit code", async () => {
    await cops(["install"]);
    w.respond("print", {
      code: 0,
      stdout: "x = {\n\tstate = not running\n\tlast exit code = 78\n}",
    });
    const r = await cops(["status"]);
    expect(r.code).toBe(1);
    expect(r.out).toContain("state    loaded, not running (last exit 78)");
  });

  test("systemd: systemctl --user show, parsed", async () => {
    const linux = { platform: "linux" as const };
    await cops(["install"], linux);
    w.calls.length = 0;
    w.respond("show", {
      code: 0,
      stdout: "LoadState=loaded\nActiveState=active\nSubState=running\nMainPID=812\n",
    });
    const r = await cops(["status"], linux);
    expect(r.code).toBe(0);
    expect(w.calls[0]?.slice(0, 4)).toEqual([S, "--user", "show", "copsd.service"]);
    expect(r.out).toContain("systemd --user unit copsd.service): running, pid 812");
  });

  test("another platform or another home is not queried (and cannot count as running)", async () => {
    await cops(["install", "--platform", "linux"]);
    const r = await cops(["status", "--platform", "linux"]);
    expect(r.code).toBe(1);
    expect(r.out).toContain("not queried: this machine is darwin, the unit is for linux");
    expect(w.calls).toEqual([]);
  });

  test("the last 20 lines of the log; an unresolvable program is said, not guessed", async () => {
    mkdirSync(join(w.home, ".jev-cops"), { recursive: true });
    const log = Array.from({ length: 25 }, (_, i) => `copsd: line ${i}`).join("\n");
    writeFileSync(join(w.home, ".jev-cops", "copsd.log"), log);
    const r = await cops(["status"], {
      runtime: { execPath: join(w.root, "nope", "cops"), main: "/$bunfs/root/cops" },
    });
    expect(r.out).toContain("(last 20 lines)");
    expect(r.out).toContain("    copsd: line 24");
    expect(r.out).not.toContain("copsd: line 4\n");
    expect(r.out).toContain("program  cannot resolve: copsd not found next to cops");
  });

  test("--json: the status document", async () => {
    await cops(["install"]);
    w.respond("print", { code: 0, stdout: RUNNING });
    const r = await cops(["status", "--json"]);
    expect(JSON.parse(r.out)).toMatchObject({
      schema: "jev-cops.service/1",
      action: "status",
      manager: "launchd",
      installed: true,
      upToDate: true,
      program: [w.copsd],
      state: { loaded: true, running: true, pid: 4123 },
      notQueried: null,
      logTail: [],
      ok: true,
    });
  });
});

describe("cops service usage", () => {
  test.each([
    [[], "expected one of install, uninstall, status, got nothing"],
    [["start"], "expected one of install, uninstall, status, got start"],
    [["install", "extra"], "unexpected argument: extra"],
    [["install", "--frob"], "Unknown option '--frob'"],
    [["install", "--platform", "windows"], '--platform must be darwin or linux, got "windows"'],
    [["status", "--dry-run"], "--dry-run is for install and uninstall"],
    [["install", "--home="], "--home needs a directory"],
  ])("%p → exit 2: %s", async (argv, message) => {
    const r = await cops(argv);
    expect(r.code).toBe(2);
    expect(r.err).toContain(message);
    expect(r.err).toContain(SERVICE_USAGE);
    expect(w.calls).toEqual([]);
  });

  test("a platform with no supported service manager needs --platform", async () => {
    const r = await cops(["install"], { platform: "win32" });
    expect(r.code).toBe(2);
    expect(r.err).toContain("win32 has no supported service manager");
    const rendered = await cops(["install", "--platform", "linux", "--dry-run"], {
      platform: "win32",
    });
    expect(rendered.code).toBe(0);
  });
});
