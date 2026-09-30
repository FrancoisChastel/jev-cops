import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  parseSystemctlShow,
  renderSystemdUnit,
  systemdInstallSteps,
  systemdStatusStep,
  systemdUninstallSteps,
} from "./systemd.ts";
import { serviceSpec } from "./units.ts";

const golden = (name: string) => readFileSync(join(import.meta.dir, "fixtures", name), "utf8");
const HOME = "/home/me";
const SYSTEMCTL = "/usr/bin/systemctl";

describe("renderSystemdUnit (goldens, byte-identical)", () => {
  test("compiled install: copsd by absolute path, no specifiers", () => {
    const spec = serviceSpec("linux", HOME, ["/home/me/.local/bin/copsd"]);
    expect(renderSystemdUnit(spec)).toEqual({
      ok: true,
      value: golden("systemd-compiled.service"),
    });
  });

  test("npm install: the absolute bun and the installed daemon entry", () => {
    const spec = serviceSpec("linux", HOME, [
      "/home/me/.bun/bin/bun",
      "/home/me/.bun/install/global/node_modules/@jev-cops/daemon/src/main.ts",
    ]);
    expect(renderSystemdUnit(spec)).toEqual({ ok: true, value: golden("systemd-npm.service") });
  });

  test.each([
    ["/home/jo smith", "whitespace"],
    ["/home/100%", "%"],
    ["/home/$USER", "$"],
    ['/home/"q"', '"'],
    ["/home/a;b", ";"],
    ["/home/a\\b", "\\"],
  ])("a home like %p is refused rather than escaped (%s)", (home, why) => {
    const r = renderSystemdUnit(serviceSpec("linux", home, [`${home}/copsd`]));
    expect(r.ok).toBe(false);
    expect(r.ok ? "" : r.error).toStartWith("cannot write ");
    expect(r.ok ? "" : r.error).toContain(`(${why})`);
  });

  test("non-ASCII paths are fine", () => {
    const r = renderSystemdUnit(serviceSpec("linux", "/home/françois", ["/home/françois/copsd"]));
    expect(r.ok).toBe(true);
  });
});

describe("systemctl --user steps", () => {
  test("install reloads units and enables it now; a re-install also restarts it", () => {
    const base = [
      { argv: [SYSTEMCTL, "--user", "daemon-reload"], ok: [0] },
      { argv: [SYSTEMCTL, "--user", "enable", "--now", "copsd.service"], ok: [0] },
    ];
    expect(systemdInstallSteps(SYSTEMCTL, false)).toEqual(base);
    expect(systemdInstallSteps(SYSTEMCTL, true)).toEqual([
      ...base,
      { argv: [SYSTEMCTL, "--user", "restart", "copsd.service"], ok: [0] },
    ]);
  });

  test("uninstall disables and stops it before the file goes, then reloads", () => {
    expect(systemdUninstallSteps(SYSTEMCTL)).toEqual({
      before: [{ argv: [SYSTEMCTL, "--user", "disable", "--now", "copsd.service"], ok: [0] }],
      after: [{ argv: [SYSTEMCTL, "--user", "daemon-reload"], ok: [0] }],
    });
  });

  test("status reads properties only", () => {
    expect(systemdStatusStep(SYSTEMCTL)).toEqual({
      argv: [
        SYSTEMCTL,
        "--user",
        "show",
        "copsd.service",
        "--property=LoadState,ActiveState,SubState,MainPID,ExecMainStatus",
      ],
      ok: [0],
    });
  });
});

describe("parseSystemctlShow", () => {
  test("active and running", () => {
    const out =
      "LoadState=loaded\nActiveState=active\nSubState=running\nMainPID=812\nExecMainStatus=0\n";
    expect(parseSystemctlShow(0, out)).toEqual({
      loaded: true,
      running: true,
      pid: 812,
      lastExit: "0",
    });
  });

  test("failed, not found, or systemctl itself failing", () => {
    const failed =
      "LoadState=loaded\nActiveState=failed\nSubState=failed\nMainPID=0\nExecMainStatus=1\n";
    expect(parseSystemctlShow(0, failed)).toEqual({
      loaded: true,
      running: false,
      pid: null,
      lastExit: "1",
    });
    expect(parseSystemctlShow(0, "LoadState=not-found\nActiveState=inactive\nMainPID=0\n")).toEqual(
      {
        loaded: false,
        running: false,
        pid: null,
        lastExit: null,
      },
    );
    expect(parseSystemctlShow(1, "Failed to connect to bus")).toEqual({
      loaded: false,
      running: false,
      pid: null,
      lastExit: null,
    });
  });
});
