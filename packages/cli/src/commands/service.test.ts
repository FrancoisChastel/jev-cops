import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { captureIo } from "../io.ts";
import { renderLaunchdPlist } from "../service/launchd.ts";
import { renderSystemdUnit } from "../service/systemd.ts";
import { type ServiceWorld, serviceWorld } from "../service/testing.ts";
import { serviceSpec } from "../service/units.ts";
import { runServiceCommand } from "./service.ts";

let w: ServiceWorld;
beforeEach(() => {
  w = serviceWorld();
});
afterEach(() => w.dispose());

const plist = () => join(w.home, "Library", "LaunchAgents", "dev.jev-cops.copsd.plist");
const unit = () => join(w.home, ".config", "systemd", "user", "copsd.service");
const L = "/bin/launchctl";
const S = "/usr/bin/systemctl";

async function cops(argv: string[], over: Parameters<ServiceWorld["factory"]>[0] = {}) {
  const io = captureIo();
  const code = await runServiceCommand(argv, io, w.factory(over));
  return { code, out: io.stdout.join("\n"), err: io.stderr.join("\n") };
}

function expectedPlist(): string {
  const r = renderLaunchdPlist(serviceSpec("darwin", w.home, [w.copsd]));
  return r.ok ? r.value : "";
}

describe("cops service install (launchd)", () => {
  test("writes the plist under --home, bootstraps it, waits for /v1/health", async () => {
    const r = await cops(["install"]);
    expect(r.code).toBe(0);
    expect(readFileSync(plist(), "utf8")).toBe(expectedPlist());
    expect(statSync(plist()).mode & 0o777).toBe(0o644);
    expect(statSync(join(w.home, ".jev-cops")).mode & 0o777).toBe(0o700);
    expect(w.calls).toEqual([[L, "bootstrap", "gui/501", plist()]]);
    expect(w.healthCalls()).toBe(1);
    expect(r.out).toContain(`ran      ${L} bootstrap gui/501 ${plist()} (exit 0)`);
    expect(r.out).toContain(`program  ${w.copsd} (compiled)`);
    expect(r.out).toContain("health   copsd answers /v1/health (test)");
  });

  test("a re-install boots the loaded one out first; 'not loaded' (3) is fine", async () => {
    await cops(["install"]);
    w.calls.length = 0;
    w.respond("bootout", { code: 3, stderr: "Boot-out failed: 3: No such process" });
    const r = await cops(["install"]);
    expect(r.code).toBe(0);
    expect(w.calls).toEqual([
      [L, "bootout", "gui/501/dev.jev-cops.copsd"],
      [L, "bootstrap", "gui/501", plist()],
    ]);
    expect(r.out).toContain("(unchanged)");
    expect(r.out).toContain("(exit 3, not loaded: fine)");
  });

  test("a failed bootstrap exits 1 with launchctl's line, the status and the log tail", async () => {
    mkdirSync(join(w.home, ".jev-cops"), { recursive: true });
    const log = Array.from({ length: 30 }, (_, i) => `line ${i}`).join("\n");
    writeFileSync(join(w.home, ".jev-cops", "copsd.log"), `${log}\n`);
    w.respond("bootstrap", { code: 5, stderr: "Bootstrap failed: 5: Input/output error\n" });
    w.respond("print", { code: 113, stdout: "Could not find service" });
    const r = await cops(["install"]);
    expect(r.code).toBe(1);
    expect(r.err).toContain(
      `cops service install: ${L} bootstrap gui/501 ${plist()} exited 5: Bootstrap failed: 5: Input/output error`,
    );
    expect(r.err).toContain("state    not loaded");
    expect(r.err).toContain("    line 29");
    expect(r.err).not.toContain("    line 9\n");
    expect(w.healthCalls()).toBe(0);
  });

  test("copsd not answering /v1/health is a failure", async () => {
    w.setHealth({ ok: false, detail: "no answer on /x/copsd.sock within 10000 ms" });
    const r = await cops(["install"]);
    expect(r.code).toBe(1);
    expect(r.err).toContain(
      "copsd did not answer after install: no answer on /x/copsd.sock within 10000 ms",
    );
  });

  test("--dry-run writes nothing, runs nothing, shows the commands and the plist", async () => {
    const r = await cops(["install", "--dry-run"]);
    expect(r.code).toBe(0);
    expect(existsSync(join(w.home, "Library"))).toBe(false);
    expect(existsSync(join(w.home, ".jev-cops"))).toBe(false);
    expect(w.calls).toEqual([]);
    expect(w.healthCalls()).toBe(0);
    expect(r.out).toContain("not run  dry run; the commands are:");
    expect(r.out).toContain(`    ${L} bootstrap gui/501 ${plist()}`);
    expect(r.out).toContain("<string>dev.jev-cops.copsd</string>");
    expect(r.out).toContain("dry run: nothing written, nothing run");
  });

  test("a unit for another platform is written but nothing is run", async () => {
    const r = await cops(["install", "--platform", "darwin"], { platform: "linux" });
    expect(r.code).toBe(0);
    expect(readFileSync(plist(), "utf8")).toBe(expectedPlist());
    expect(w.calls).toEqual([]);
    expect(r.out).toContain(
      "not run  this machine is linux, the unit is for darwin; the commands are:",
    );
  });

  test("another --home gets its files, but nothing loads into this user's session", async () => {
    const other = join(w.root, "other-home");
    mkdirSync(other);
    const r = await cops(["install", "--home", other]);
    expect(r.code).toBe(0);
    expect(existsSync(join(other, "Library", "LaunchAgents", "dev.jev-cops.copsd.plist"))).toBe(
      true,
    );
    expect(existsSync(plist())).toBe(false);
    expect(w.calls).toEqual([]);
    expect(r.out).toContain(`--home ${other} is not this user's home`);
  });

  test("no copsd next to a compiled cops: refused, nothing written", async () => {
    const r = await cops(["install"], {
      runtime: { execPath: join(w.root, "elsewhere", "cops"), main: "/$bunfs/root/cops" },
    });
    expect(r.code).toBe(1);
    expect(r.err).toContain("copsd not found next to cops");
    expect(existsSync(join(w.home, "Library"))).toBe(false);
  });

  test("--json: one jev-cops.service/1 document", async () => {
    const r = await cops(["install", "--json"]);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out)).toMatchObject({
      schema: "jev-cops.service/1",
      action: "install",
      platform: "darwin",
      manager: "launchd",
      unit: plist(),
      program: [w.copsd],
      install: "compiled",
      file: "written",
      planned: [[L, "bootstrap", "gui/501", plist()]],
      steps: [{ argv: [L, "bootstrap", "gui/501", plist()], code: 0, ok: true }],
      notRun: null,
      health: { ok: true },
      ok: true,
      error: null,
    });
    const bad = await cops(["install", "--json"], {
      runtime: { execPath: join(w.root, "nope", "cops"), main: "/$bunfs/root/cops" },
    });
    expect(JSON.parse(bad.out)).toMatchObject({ ok: false, action: "install" });
  });
});

describe("cops service install (systemd --user)", () => {
  const linux = { platform: "linux" as const };

  test("writes the unit, reloads, enables it now", async () => {
    const r = await cops(["install"], linux);
    expect(r.code).toBe(0);
    const expected = renderSystemdUnit(serviceSpec("linux", w.home, [w.copsd]));
    expect(readFileSync(unit(), "utf8")).toBe(expected.ok ? expected.value : "");
    expect(w.calls).toEqual([
      [S, "--user", "daemon-reload"],
      [S, "--user", "enable", "--now", "copsd.service"],
    ]);
  });

  test("a re-install also restarts it", async () => {
    await cops(["install"], linux);
    w.calls.length = 0;
    await cops(["install"], linux);
    expect(w.calls.at(-1)).toEqual([S, "--user", "restart", "copsd.service"]);
  });

  test("a home systemd would reinterpret is refused before anything is written", async () => {
    const spaced = join(w.root, "jo smith");
    mkdirSync(spaced);
    const r = await cops(["install", "--home", spaced], linux);
    expect(r.code).toBe(1);
    expect(r.err).toContain("into a systemd unit (whitespace)");
    expect(readdirSync(spaced)).toEqual([]);
  });
});

describe("cops service uninstall", () => {
  test("launchd: boots it out, removes the plist, keeps the log", async () => {
    await cops(["install"]);
    writeFileSync(join(w.home, ".jev-cops", "copsd.log"), "last words\n");
    w.calls.length = 0;
    const r = await cops(["uninstall"]);
    expect(r.code).toBe(0);
    expect(w.calls).toEqual([[L, "bootout", "gui/501/dev.jev-cops.copsd"]]);
    expect(readdirSync(join(w.home, "Library", "LaunchAgents"))).toEqual([]);
    expect(readFileSync(join(w.home, ".jev-cops", "copsd.log"), "utf8")).toBe("last words\n");
    expect(r.out).toContain("(removed)");
    expect(r.out).toContain(`kept     ${join(w.home, ".jev-cops", "copsd.log")}`);
  });

  test("launchd: a bootout that fails for another reason keeps the plist", async () => {
    await cops(["install"]);
    w.respond("bootout", { code: 5, stderr: "Boot-out failed: 5: Input/output error" });
    const r = await cops(["uninstall"]);
    expect(r.code).toBe(1);
    expect(existsSync(plist())).toBe(true);
    expect(r.err).toContain("exited 5: Boot-out failed: 5: Input/output error");
  });

  test("systemd: disable --now, remove, reload; nothing is left", async () => {
    const linux = { platform: "linux" as const };
    await cops(["install"], linux);
    w.calls.length = 0;
    const r = await cops(["uninstall"], linux);
    expect(r.code).toBe(0);
    expect(w.calls).toEqual([
      [S, "--user", "disable", "--now", "copsd.service"],
      [S, "--user", "daemon-reload"],
    ]);
    expect(readdirSync(join(w.home, ".config", "systemd", "user"))).toEqual([]);
  });

  test("systemd: not installed runs nothing and succeeds", async () => {
    const r = await cops(["uninstall"], { platform: "linux" });
    expect(r.code).toBe(0);
    expect(w.calls).toEqual([]);
    expect(r.out).toContain("(not installed)");
  });

  test("--dry-run removes nothing and runs nothing", async () => {
    await cops(["install"]);
    w.calls.length = 0;
    const r = await cops(["uninstall", "--dry-run"]);
    expect(r.code).toBe(0);
    expect(existsSync(plist())).toBe(true);
    expect(w.calls).toEqual([]);
    expect(r.out).toContain("(would remove)");
  });
});
