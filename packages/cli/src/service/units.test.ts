import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  LOG_FILE,
  logPath,
  managerOf,
  resolveDaemonProgram,
  SERVICE_LABEL,
  SYSTEMD_UNIT,
  servicePathEnv,
  serviceSpec,
  unitPath,
} from "./units.ts";

let root: string;

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "jvsvc-units-")));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function exe(path: string): string {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, "#!/bin/sh\n");
  chmodSync(path, 0o755);
  return path;
}

describe("names and paths", () => {
  test("launchd on macOS, systemd --user on Linux, under the given home", () => {
    expect(managerOf("darwin")).toBe("launchd");
    expect(managerOf("linux")).toBe("systemd");
    expect(SERVICE_LABEL).toBe("dev.jev-cops.copsd");
    expect(SYSTEMD_UNIT).toBe("copsd.service");
    expect(unitPath("launchd", "/Users/me")).toBe(
      "/Users/me/Library/LaunchAgents/dev.jev-cops.copsd.plist",
    );
    expect(unitPath("systemd", "/home/me")).toBe("/home/me/.config/systemd/user/copsd.service");
    expect(logPath("/home/me")).toBe(`/home/me/.jev-cops/${LOG_FILE}`);
  });

  test("an explicit PATH: system directories first, then the user's tool directories", () => {
    expect(servicePathEnv("darwin", "/Users/me")).toBe(
      "/usr/bin:/bin:/usr/sbin:/sbin:/Users/me/.local/bin:/Users/me/.bun/bin:/opt/homebrew/bin:/usr/local/bin",
    );
    expect(servicePathEnv("linux", "/home/me")).toBe(
      "/usr/local/bin:/usr/bin:/bin:/home/me/.local/bin:/home/me/.bun/bin",
    );
  });

  test("serviceSpec gathers what a unit needs", () => {
    expect(serviceSpec("linux", "/home/me", ["/home/me/.local/bin/copsd"])).toEqual({
      program: ["/home/me/.local/bin/copsd"],
      home: "/home/me",
      pathEnv: "/usr/local/bin:/usr/bin:/bin:/home/me/.local/bin:/home/me/.bun/bin",
      logPath: "/home/me/.jev-cops/copsd.log",
    });
  });
});

describe("resolveDaemonProgram", () => {
  const noEntry = () => null;

  test("compiled cops: the copsd next to it (install.sh puts all three in one bin dir)", () => {
    const copsd = exe(join(root, "bin", "copsd"));
    const r = resolveDaemonProgram(
      { execPath: join(root, "bin", "cops"), main: "/$bunfs/root/cops" },
      { resolveEntry: noEntry, pathEnv: "" },
    );
    expect(r).toEqual({ ok: true, value: { program: [copsd], install: "compiled" } });
  });

  test("compiled cops without a copsd beside it, or one that cannot run, is refused", () => {
    const runtime = { execPath: join(root, "bin", "cops"), main: "/$bunfs/root/cops" };
    const missing = resolveDaemonProgram(runtime, { resolveEntry: noEntry, pathEnv: "" });
    expect(missing.ok ? "" : missing.error).toBe(
      `copsd not found next to cops (${join(root, "bin", "copsd")}): reinstall jev-cops`,
    );
    mkdirSync(join(root, "bin"));
    writeFileSync(join(root, "bin", "copsd"), "");
    chmodSync(join(root, "bin", "copsd"), 0o644);
    const plain = resolveDaemonProgram(runtime, { resolveEntry: noEntry, pathEnv: "" });
    expect(plain.ok ? "" : plain.error).toContain("is not executable");
  });

  test("the npm path: the running bun and the installed daemon entry, both absolute", () => {
    const bun = exe(join(root, "cellar", "bun"));
    const entry = join(root, "node_modules", "@jev-cops", "daemon", "src", "main.ts");
    mkdirSync(join(entry, ".."), { recursive: true });
    writeFileSync(entry, "");
    const r = resolveDaemonProgram(
      { execPath: bun, main: join(root, "node_modules", "@jev-cops", "cli", "src", "main.ts") },
      { resolveEntry: () => entry, pathEnv: "" },
    );
    expect(r).toEqual({ ok: true, value: { program: [bun, entry], install: "package" } });
  });

  test("the jev-cops package: its bin/copsd.ts next to the running bin/cops.ts wins (D-108)", () => {
    const bun = exe(join(root, "bun"));
    const bin = join(root, "node_modules", "jev-cops", "bin");
    const copsdTs = exe(join(bin, "copsd.ts"));
    const daemon = exe(join(root, "node_modules", "@jev-cops", "daemon", "src", "main.ts"));
    const r = resolveDaemonProgram(
      { execPath: bun, main: join(bin, "cops.ts") },
      { resolveEntry: () => daemon, pathEnv: "" },
    );
    expect(r).toEqual({ ok: true, value: { program: [bun, copsdTs], install: "package" } });
  });

  test("a bun reached through a stable link on the service PATH is named by that link", () => {
    const bun = exe(join(root, "Cellar", "bun", "1.3.13", "bin", "bun"));
    mkdirSync(join(root, "brew", "bin"), { recursive: true });
    symlinkSync(bun, join(root, "brew", "bin", "bun"));
    const entry = exe(join(root, "daemon", "main.ts"));
    const r = resolveDaemonProgram(
      { execPath: bun, main: "/src/cli/main.ts" },
      { resolveEntry: () => entry, pathEnv: `/nonexistent:${join(root, "brew", "bin")}` },
    );
    expect(r.ok && r.value.program[0]).toBe(join(root, "brew", "bin", "bun"));
  });

  test("the daemon package not installed, or its entry missing, is refused", () => {
    const bun = exe(join(root, "bun"));
    const runtime = { execPath: bun, main: "/src/cli/main.ts" };
    const none = resolveDaemonProgram(runtime, { resolveEntry: noEntry, pathEnv: "" });
    expect(none.ok ? "" : none.error).toBe(
      "@jev-cops/daemon is not installed next to @jev-cops/cli: reinstall jev-cops",
    );
    const gone = resolveDaemonProgram(runtime, {
      resolveEntry: () => join(root, "gone.ts"),
      pathEnv: "",
    });
    expect(gone.ok ? "" : gone.error).toBe(
      `the daemon entry ${join(root, "gone.ts")} does not exist`,
    );
  });
});
