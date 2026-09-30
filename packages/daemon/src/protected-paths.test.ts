import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type { DaemonConfig } from "./config.ts";
import {
  compiledBinary,
  defaultJudgeInputs,
  type JudgeInputs,
  judgeInputPaths,
  protectJudgeInputs,
} from "./protected-paths.ts";
import { testConfig } from "./testing/daemon.ts";

/** A config whose every input lives in its own directory, none of them shared. */
function spread(over: Partial<DaemonConfig["daemon"]> = {}): DaemonConfig {
  const base = testConfig("/srv/jv", { policies: {} });
  return {
    ...base,
    daemon: {
      ...base.daemon,
      socket: "/run/jv/d.sock",
      adminSocket: "/run/jv-admin/a.sock",
      hookBinary: "/opt/jv/bin/cops-hook",
      ...over,
    },
    policies: { dir: "/srv/jv/policies" },
    audit: {
      path: "/srv/jv-log/audit.jsonl",
      forward: { kind: "file", target: "/mnt/copy.jsonl" },
    },
    store: { path: "/srv/jv-db/store.sqlite" },
  };
}

const INPUTS: JudgeInputs = {
  configFiles: ["/srv/jv-etc/cops.toml"],
  selfBinary: "/opt/jv/bin/copsd",
  osHome: "/home/dev",
  cwd: "/work/repo",
};

describe("judgeInputPaths: everything the judge reads or writes", () => {
  test("policies dir, audit, store, both sockets, config, ~/.jev-cops/ and both binaries", () => {
    const paths = judgeInputPaths(spread(), INPUTS);
    expect(paths).toEqual(
      expect.arrayContaining([
        "/srv/jv/policies",
        "/srv/jv-log",
        "/srv/jv-log/audit.jsonl",
        "/mnt/copy.jsonl",
        "/srv/jv-db",
        "/srv/jv-db/store.sqlite",
        "/run/jv",
        "/run/jv/d.sock",
        "/run/jv-admin",
        "/run/jv-admin/a.sock",
        "/srv/jv-etc",
        "/srv/jv-etc/cops.toml",
        "/home/dev/.jev-cops",
        "/opt/jv/bin/copsd",
        "/opt/jv/bin/cops-hook",
      ]),
    );
  });

  test("binaries are protected as files, never their directories", () => {
    const paths = judgeInputPaths(spread(), INPUTS);
    expect(paths).not.toContain("/opt/jv/bin");
  });

  test("no hook binary configured and not compiled: neither binary is listed", () => {
    const paths = judgeInputPaths(spread({ hookBinary: null }), { ...INPUTS, selfBinary: null });
    expect(paths.some((p) => p.includes("/opt/jv/bin"))).toBe(false);
  });

  test("~/.jev-cops/ under the OS home and under [daemon] home when they differ", () => {
    const paths = judgeInputPaths(spread({ home: "/home/judged" }), INPUTS);
    expect(paths).toContain("/home/dev/.jev-cops");
    expect(paths).toContain("/home/judged/.jev-cops");
  });

  test("every entry is absolute and listed once", () => {
    const paths = judgeInputPaths(spread(), INPUTS);
    expect(new Set(paths).size).toBe(paths.length);
    expect(paths.every((p) => p.startsWith("/"))).toBe(true);
  });
});

describe("shared directories are never protected whole (only the file in them)", () => {
  test("a socket in /tmp protects the socket, not /tmp", () => {
    const paths = judgeInputPaths(spread({ socket: "/tmp/copsd.sock" }), INPUTS);
    expect(paths).toContain("/tmp/copsd.sock");
    expect(paths).not.toContain("/tmp");
  });

  test("an audit log in the home dir, a config in the daemon's cwd", () => {
    const config = { ...spread(), audit: { path: "/home/dev/audit.jsonl", forward: null } };
    const paths = judgeInputPaths(config, { ...INPUTS, configFiles: ["/work/repo/j.toml"] });
    expect(paths).toContain("/home/dev/audit.jsonl");
    expect(paths).toContain("/work/repo/j.toml");
    for (const broad of ["/", "/home", "/home/dev", "/work", "/work/repo"]) {
      expect(paths).not.toContain(broad);
    }
  });

  test("a store in the system temp dir also protects its SQLite side files", () => {
    const store = join(tmpdir(), "cops.sqlite");
    const paths = judgeInputPaths({ ...spread(), store: { path: store } }, INPUTS);
    expect(paths).toEqual(
      expect.arrayContaining([store, `${store}-wal`, `${store}-shm`, `${store}-journal`]),
    );
    expect(paths).not.toContain(tmpdir());
  });

  test("the policies directory is itself the input: protected whole wherever it is", () => {
    const config = { ...spread(), policies: { dir: "/work/repo/policies" } };
    expect(judgeInputPaths(config, INPUTS)).toContain("/work/repo/policies");
  });
});

describe("symlinked locations are protected under their real path too", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "jvp-"));
    mkdirSync(join(root, "real", "policies"), { recursive: true });
    symlinkSync(join(root, "real"), join(root, "link"));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  test("the configured path and the resolved one, even for a file not yet created", () => {
    const real = realpathSync(join(root, "real"));
    const config = {
      ...spread(),
      policies: { dir: join(root, "link", "policies") },
      audit: { path: join(root, "link", "logs", "audit.jsonl"), forward: null },
    };
    const paths = judgeInputPaths(config, INPUTS);
    expect(paths).toContain(join(root, "link", "policies"));
    expect(paths).toContain(join(real, "policies"));
    expect(paths).toContain(join(real, "logs", "audit.jsonl"));
  });
});

describe("protectJudgeInputs: appends, never replaces", () => {
  test("configured entries stay first, the judge's own follow, the input is untouched", () => {
    const given = { ...spread(), policy: { protectedPaths: ["~/bin/tool", "/srv/jv/policies"] } };
    const protectedConfig = protectJudgeInputs(given, INPUTS);
    const paths = protectedConfig.policy.protectedPaths ?? [];
    expect(paths.slice(0, 2)).toEqual(["~/bin/tool", "/srv/jv/policies"]);
    expect(paths.filter((p) => p === "/srv/jv/policies")).toHaveLength(1);
    expect(paths).toContain("/srv/jv-log/audit.jsonl");
    expect(given.policy.protectedPaths).toEqual(["~/bin/tool", "/srv/jv/policies"]);
  });

  test("an empty configured list (what a repo override may keep) still gets every entry", () => {
    const given = { ...spread(), policy: { protectedPaths: [] } };
    const paths = protectJudgeInputs(given, INPUTS).policy.protectedPaths ?? [];
    expect(paths).toEqual(judgeInputPaths(given, INPUTS));
  });
});

describe("the running binary and the defaults", () => {
  test("process.execPath counts only inside a compiled binary", () => {
    expect(compiledBinary("/$bunfs/root/copsd", "/usr/local/bin/copsd")).toBe(
      "/usr/local/bin/copsd",
    );
    expect(compiledBinary("B:/~BUN/root/copsd.exe", "C:\\jv\\copsd.exe")).toBe("C:\\jv\\copsd.exe");
    expect(compiledBinary("/work/packages/daemon/src/main.ts", "/opt/bun/bin/bun")).toBeNull();
  });

  test("defaults: the user config file, the OS home, the cwd; not compiled under bun test", () => {
    expect(defaultJudgeInputs()).toEqual({
      configFiles: [join(homedir(), ".config", "jev-cops", "cops.toml")],
      selfBinary: null,
      osHome: homedir(),
      cwd: process.cwd(),
    });
  });
});
