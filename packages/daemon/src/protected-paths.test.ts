import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type { AuditForward, DaemonConfig } from "./config.ts";
import {
  compiledBinary,
  defaultJudgeInputs,
  installedCodeDirs,
  type JudgeInputs,
  judgeInputPaths,
  judgePrivatePaths,
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
      ...base.audit,
      path: "/srv/jv-log/audit.jsonl",
      forward: forwardTo("file", "/mnt/copy.jsonl"),
      key: "/srv/jv-keys/audit-ed25519.key",
      publicKey: "/srv/jv-pub/audit-ed25519.pub",
    },
    store: { path: "/srv/jv-db/store.sqlite" },
  };
}

/** A `[audit.forward]` of `kind`, its cursor in its own directory. */
function forwardTo(kind: "file" | "syslog", target: string): AuditForward {
  const syslog = {
    host: "siem",
    port: 6514,
    ca: "/etc/jv-tls/ca.pem",
    cert: "/etc/jv-tls/client.pem",
    key: "/etc/jv-tls/client.key",
    serverName: null,
    facility: 16,
    appName: "copsd",
    enterpriseNumber: 32473,
    maxMessageBytes: 8192,
    resendOverlap: 100,
  };
  return {
    kind,
    target,
    required: false,
    maxLagLines: 1000,
    maxLagMs: 60_000,
    cursor: "/srv/jv-cursor/forward.cursor",
    syslog: kind === "syslog" ? syslog : null,
  };
}

describe("the audit's own files (D-103, D-104)", () => {
  test("protected: cursor, signing key and its pending rotation, public key, TLS files", () => {
    const config = {
      ...spread(),
      audit: { ...spread().audit, forward: forwardTo("syslog", "siem:6514") },
    };
    const paths = judgeInputPaths(config, INPUTS);
    expect(paths).toEqual(
      expect.arrayContaining([
        "/srv/jv-cursor",
        "/srv/jv-cursor/forward.cursor",
        "/srv/jv-keys",
        "/srv/jv-keys/audit-ed25519.key",
        "/srv/jv-pub/audit-ed25519.pub",
        "/etc/jv-tls/ca.pem",
        "/etc/jv-tls/client.pem",
        "/etc/jv-tls/client.key",
      ]),
    );
    expect(paths).not.toContain("/etc/jv-tls");
    expect(paths).not.toContain("/srv/jv-pub");
    expect(paths).not.toContain("siem:6514");
  });

  test("private: cursor, signing key and the client key; never the public key or the CA", () => {
    const config = {
      ...spread(),
      audit: { ...spread().audit, forward: forwardTo("syslog", "siem:6514") },
    };
    const paths = judgePrivatePaths(config, INPUTS);
    expect(paths).toEqual(
      expect.arrayContaining([
        "/srv/jv-cursor/forward.cursor",
        "/srv/jv-keys",
        "/srv/jv-keys/audit-ed25519.key",
        "/etc/jv-tls/client.key",
      ]),
    );
    expect(paths).not.toContain("/srv/jv-pub/audit-ed25519.pub");
    expect(paths).not.toContain("/etc/jv-tls/ca.pem");
  });

  test("a key in a shared directory: the key and its pending rotation, not the directory", () => {
    const key = join(tmpdir(), "audit.key");
    const config = { ...spread(), audit: { ...spread().audit, key } };
    const paths = judgePrivatePaths(config, INPUTS);
    expect(paths).toEqual(expect.arrayContaining([key, `${key}.next`]));
    expect(paths).not.toContain(tmpdir());
  });
});

const INPUTS: JudgeInputs = {
  configFiles: ["/srv/jv-etc/cops.toml"],
  selfBinary: "/opt/jv/bin/copsd",
  installedCode: [],
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
    const config = {
      ...spread(),
      audit: { ...spread().audit, path: "/home/dev/audit.jsonl", forward: null },
    };
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
      audit: { ...spread().audit, path: join(root, "link", "logs", "audit.jsonl"), forward: null },
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

describe("judgePrivatePaths: the judge's own records, never its policies or config", () => {
  test("audit (file, dir, forward copy), store, ~/.jev-cops/ and the adapters' records", () => {
    const paths = judgePrivatePaths(spread(), INPUTS);
    expect(paths).toEqual(
      expect.arrayContaining([
        "/srv/jv-log",
        "/srv/jv-log/audit.jsonl",
        "/mnt/copy.jsonl",
        "/srv/jv-db",
        "/srv/jv-db/store.sqlite",
        "/home/dev/.jev-cops",
        "/home/dev/.jev-cops/claude-code-hook.log",
        "/home/dev/.jev-cops/claude-code.json",
      ]),
    );
  });

  test("sockets, the policies dir and the config files are exempt (`!`), never private", () => {
    const paths = judgePrivatePaths(spread(), INPUTS);
    expect(paths).toEqual(
      expect.arrayContaining([
        "!/run/jv/d.sock",
        "!/run/jv-admin/a.sock",
        "!/srv/jv/policies",
        "!/srv/jv-etc/cops.toml",
      ]),
    );
    for (const open of ["/run/jv/d.sock", "/srv/jv/policies", "/srv/jv-etc/cops.toml", "/run/jv"]) {
      expect(paths).not.toContain(open);
    }
    expect(paths.some((p) => p.includes("/opt/jv/bin"))).toBe(false);
  });

  test("the default layout: ~/.jev-cops/ is private, its sockets are exempt", () => {
    const base = spread({
      socket: "/home/dev/.jev-cops/copsd.sock",
      adminSocket: "/home/dev/.jev-cops/copsd-admin.sock",
    });
    const config = {
      ...base,
      audit: { ...base.audit, path: "/home/dev/.jev-cops/audit.jsonl", forward: null },
      store: { path: "/home/dev/.jev-cops/cops.sqlite" },
    };
    const paths = judgePrivatePaths(config, INPUTS);
    expect(paths).toContain("/home/dev/.jev-cops");
    expect(paths).toContain("/home/dev/.jev-cops/audit.jsonl");
    expect(paths).toContain("!/home/dev/.jev-cops/copsd.sock");
    expect(paths).toContain("!/home/dev/.jev-cops/copsd-admin.sock");
  });

  test("a store in a shared dir makes its SQLite side files private, not the dir", () => {
    const store = join(tmpdir(), "cops.sqlite");
    const paths = judgePrivatePaths({ ...spread(), store: { path: store } }, INPUTS);
    expect(paths).toEqual(
      expect.arrayContaining([store, `${store}-wal`, `${store}-shm`, `${store}-journal`]),
    );
    expect(paths).not.toContain(tmpdir());
  });

  test("~/.jev-cops/ under [daemon] home too, and every entry once", () => {
    const paths = judgePrivatePaths(spread({ home: "/home/judged" }), INPUTS);
    expect(paths).toContain("/home/judged/.jev-cops");
    expect(paths).toContain("/home/judged/.jev-cops/claude-code-hook.log");
    expect(new Set(paths).size).toBe(paths.length);
  });

  test("protectJudgeInputs appends them to [policy] privatePaths after the configured ones", () => {
    const given = { ...spread(), policy: { privatePaths: ["~/notes"] } };
    const paths = protectJudgeInputs(given, INPUTS).policy.privatePaths ?? [];
    expect(paths[0]).toBe("~/notes");
    expect(paths.slice(1)).toEqual(judgePrivatePaths(given, INPUTS));
    expect(given.policy.privatePaths).toEqual(["~/notes"]);
  });
});

describe("the running binary and the defaults", () => {
  test("installed from npm: the @jev-cops scope and the jev-cops bins, whole", () => {
    const g = "/home/dev/.bun/install/global/node_modules";
    expect(installedCodeDirs(`${g}/@jev-cops/daemon/src`)).toEqual([
      `${g}/@jev-cops`,
      `${g}/jev-cops`,
    ]);
    expect(installedCodeDirs("/usr/lib/node_modules/@jev-cops/daemon/src")).toEqual([
      "/usr/lib/node_modules/@jev-cops",
      "/usr/lib/node_modules/jev-cops",
    ]);
    expect(installedCodeDirs("/work/jev-cops/packages/daemon/src")).toEqual([]);
    expect(installedCodeDirs("/$bunfs/root")).toEqual([]);
    const installed = [`${g}/@jev-cops`, `${g}/jev-cops`];
    const paths = judgeInputPaths(spread(), { ...INPUTS, installedCode: installed });
    expect(paths).toEqual(expect.arrayContaining(installed));
    expect(judgeInputPaths(spread(), INPUTS).some((p) => p.includes("node_modules"))).toBe(false);
  });

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
      installedCode: [],
      osHome: homedir(),
      cwd: process.cwd(),
    });
  });
});
