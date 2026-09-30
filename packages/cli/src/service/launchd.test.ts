import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  launchdInstallSteps,
  launchdStatusStep,
  launchdUninstallSteps,
  parseLaunchctlPrint,
  renderLaunchdPlist,
} from "./launchd.ts";
import { serviceSpec } from "./units.ts";

const golden = (name: string) => readFileSync(join(import.meta.dir, "fixtures", name), "utf8");
const HOME = "/Users/me";
const PLIST = "/Users/me/Library/LaunchAgents/dev.jev-cops.copsd.plist";
const LAUNCHCTL = "/bin/launchctl";

describe("renderLaunchdPlist (goldens, byte-identical)", () => {
  test("compiled install: copsd by absolute path", () => {
    const spec = serviceSpec("darwin", HOME, ["/Users/me/.local/bin/copsd"]);
    expect(renderLaunchdPlist(spec)).toEqual({ ok: true, value: golden("launchd-compiled.plist") });
  });

  test("npm install: the absolute bun and the installed daemon entry", () => {
    const spec = serviceSpec("darwin", HOME, [
      "/Users/me/.bun/bin/bun",
      "/Users/me/.bun/install/global/node_modules/@jev-cops/daemon/src/main.ts",
    ]);
    expect(renderLaunchdPlist(spec)).toEqual({ ok: true, value: golden("launchd-npm.plist") });
  });

  test("XML-special characters are escaped; a home with a space is fine", () => {
    const spec = serviceSpec("darwin", "/Users/Tom & Jerry", ["/Users/Tom & Jerry/bin/<copsd>"]);
    const r = renderLaunchdPlist(spec);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value).toContain("<string>/Users/Tom &amp; Jerry/bin/&lt;copsd&gt;</string>");
    expect(r.value).not.toContain("Tom & Jerry");
  });

  test("a control character cannot be written into a plist", () => {
    const spec = serviceSpec("darwin", "/Users/me\nx", ["/Users/me/copsd"]);
    expect(renderLaunchdPlist(spec)).toEqual({
      ok: false,
      error: 'cannot write "/Users/me\\nx" into a launchd plist (control character)',
    });
  });
});

describe("launchctl steps (bootstrap/bootout, never load/unload)", () => {
  test("a fresh install bootstraps the plist into the user's GUI domain", () => {
    expect(launchdInstallSteps(LAUNCHCTL, 501, PLIST, false)).toEqual([
      { argv: [LAUNCHCTL, "bootstrap", "gui/501", PLIST], ok: [0] },
    ]);
  });

  test("a re-install boots the old one out first (tolerated when it is not loaded)", () => {
    expect(launchdInstallSteps(LAUNCHCTL, 501, PLIST, true)).toEqual([
      { argv: [LAUNCHCTL, "bootout", "gui/501/dev.jev-cops.copsd"], ok: [0, 3, 113] },
      { argv: [LAUNCHCTL, "bootstrap", "gui/501", PLIST], ok: [0] },
    ]);
  });

  test("uninstall boots it out; status prints it", () => {
    expect(launchdUninstallSteps(LAUNCHCTL, 501)).toEqual([
      { argv: [LAUNCHCTL, "bootout", "gui/501/dev.jev-cops.copsd"], ok: [0, 3, 113] },
    ]);
    expect(launchdStatusStep(LAUNCHCTL, 501)).toEqual({
      argv: [LAUNCHCTL, "print", "gui/501/dev.jev-cops.copsd"],
      ok: [0],
    });
  });
});

describe("parseLaunchctlPrint", () => {
  test("a running job: state, pid, last exit", () => {
    const out = [
      "gui/501/dev.jev-cops.copsd = {",
      "\tactive count = 1",
      `\tpath = ${PLIST}`,
      "\tstate = running",
      "\tprogram = /Users/me/.local/bin/copsd",
      "\tpid = 4123",
      "\tlast exit code = (never exited)",
      "}",
    ].join("\n");
    expect(parseLaunchctlPrint(0, out)).toEqual({
      loaded: true,
      running: true,
      pid: 4123,
      lastExit: "(never exited)",
    });
  });

  test("a loaded job waiting after a crash; an unknown service is not loaded", () => {
    const out = "gui/501/dev.jev-cops.copsd = {\n\tstate = not running\n\tlast exit code = 1\n}";
    expect(parseLaunchctlPrint(0, out)).toEqual({
      loaded: true,
      running: false,
      pid: null,
      lastExit: "1",
    });
    expect(parseLaunchctlPrint(113, "Could not find service")).toEqual({
      loaded: false,
      running: false,
      pid: null,
      lastExit: null,
    });
  });
});
