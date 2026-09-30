import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { ConfigError, DEFAULT_DAEMON_CONFIG, loadConfig, parseHttpBind } from "./config.ts";

let root: string;
let home: string;
let cwd: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "jev-cops-config-"));
  home = join(root, "home");
  cwd = join(root, "repo");
  mkdirSync(join(home, ".config", "jev-cops"), { recursive: true });
  mkdirSync(cwd, { recursive: true });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function write(path: string, text: string): string {
  writeFileSync(path, text);
  return path;
}

const userFile = () => join(home, ".config", "jev-cops", "cops.toml");
const load = (opts: { configPath?: string; env?: Record<string, string> } = {}) =>
  loadConfig({ home, cwd, env: opts.env ?? {}, ...opts });

describe("defaults", () => {
  test("observe by default, judge off, HTTP off, paths under ~/.jev-cops", () => {
    const { config, sources, rejected } = load();
    expect(sources).toEqual([]);
    expect(rejected).toEqual([]);
    expect(config.enforcement.mode).toBe("observe");
    expect(config.judge).toMatchObject({ provider: "off", timeoutMs: 10_000, cacheTtlMs: 600_000 });
    expect(config.daemon).toMatchObject({
      socket: join(home, ".jev-cops", "copsd.sock"),
      adminSocket: join(home, ".jev-cops", "copsd-admin.sock"),
      http: null,
      home,
      judgeDeadlineMs: 12_000,
      holdTokenTtlMs: 600_000,
      gitProbeTimeoutMs: 300,
      hookBinary: null,
    });
    expect(config.audit).toMatchObject({
      path: join(home, ".jev-cops", "audit.jsonl"),
      forward: null,
    });
    expect(config.store.path).toBe(join(home, ".jev-cops", "cops.sqlite"));
    expect(config.policies.dir).toBe(join(cwd, "policies"));
  });

  test("the exported defaults are frozen", () => {
    expect(Object.isFrozen(DEFAULT_DAEMON_CONFIG)).toBe(true);
    expect(DEFAULT_DAEMON_CONFIG.enforcement.mode).toBe("observe");
  });
});

describe("precedence: --config > $JEV_COPS_CONFIG > ./.cops.toml > user config", () => {
  test("user config applies, paths resolve against its directory", () => {
    write(userFile(), '[judge]\nprovider = "jev"\n[policies]\ndir = "pol"\n');
    const { config, sources } = load();
    expect(sources).toEqual([userFile()]);
    expect(config.judge.provider).toBe("jev");
    expect(config.policies.dir).toBe(join(home, ".config", "jev-cops", "pol"));
  });

  test("$JEV_COPS_CONFIG overrides the user config", () => {
    write(userFile(), '[judge]\nprovider = "jev"\n');
    const envFile = write(join(root, "env.toml"), '[judge]\nprovider = "mock"\n');
    const { config, sources } = load({ env: { JEV_COPS_CONFIG: envFile } });
    expect(config.judge.provider).toBe("mock");
    expect(sources).toEqual([userFile(), envFile]);
  });

  test("--config overrides $JEV_COPS_CONFIG", () => {
    const envFile = write(join(root, "env.toml"), '[enforcement]\nmode = "enforce"\n');
    const flagFile = write(join(root, "flag.toml"), '[enforcement]\nmode = "observe"\n');
    const { config } = load({ env: { JEV_COPS_CONFIG: envFile }, configPath: flagFile });
    expect(config.enforcement.mode).toBe("observe");
  });

  test("the repo override sits between the user file and $JEV_COPS_CONFIG", () => {
    write(userFile(), "[context.budget]\nlimit = 100\n");
    write(join(cwd, ".cops.toml"), "[context.budget]\nlimit = 50\n");
    expect(load().config.context).toEqual({ budget: { limit: 50 } });
    const envFile = write(join(root, "env.toml"), "[context.budget]\nlimit = 200\n");
    expect(load({ env: { JEV_COPS_CONFIG: envFile } }).config.context).toEqual({
      budget: { limit: 200 },
    });
  });

  test("a missing --config file is an error, a missing user file is not", () => {
    expect(() => load({ configPath: join(root, "nope.toml") })).toThrow(ConfigError);
  });
});

describe("repo override can only tighten", () => {
  test("enforce → observe from the repo is rejected and reported", () => {
    write(userFile(), '[enforcement]\nmode = "enforce"\n');
    write(join(cwd, ".cops.toml"), '[enforcement]\nmode = "observe"\n');
    const { config, rejected } = load();
    expect(config.enforcement.mode).toBe("enforce");
    expect(rejected).toEqual([expect.stringContaining("enforcement.mode")]);
  });

  test("observe → enforce from the repo is accepted", () => {
    write(join(cwd, ".cops.toml"), '[enforcement]\nmode = "enforce"\n');
    expect(load().config.enforcement.mode).toBe("enforce");
  });

  test("changing the judge provider or model from the repo is rejected", () => {
    write(join(cwd, ".cops.toml"), '[judge]\nprovider = "mock"\nmodel = "x/y"\n');
    const { config, rejected } = load();
    expect(config.judge.provider).toBe("off");
    expect(config.judge.model).toBeNull();
    expect(rejected).toHaveLength(2);
  });

  test("redirecting the audit log, store, socket or policies from the repo is rejected", () => {
    write(
      join(cwd, ".cops.toml"),
      '[audit]\npath = "/tmp/x"\n[store]\npath = "/tmp/y"\n[policies]\ndir = "mine"\n',
    );
    const { config, rejected } = load();
    expect(config.audit.path).toBe(join(home, ".jev-cops", "audit.jsonl"));
    expect(config.policies.dir).toBe(join(cwd, "policies"));
    expect(rejected).toHaveLength(3);
  });

  test("loosening a band or the budget is rejected, tightening is kept", () => {
    write(
      join(cwd, ".cops.toml"),
      "[policy.bands]\nhold = 0.4\ndeny = 0.9\n[context.budget]\nlimit = 500\n",
    );
    const { config, rejected } = load();
    expect(config.policy).toEqual({ bands: { hold: 0.4 } });
    expect(rejected.map((r) => r.split(":")[0]).sort()).toEqual([
      "context.budget.limit",
      "policy.bands.deny",
    ]);
  });

  test("moving either socket from the repo is rejected; the user file may move both", () => {
    write(
      userFile(),
      '[daemon]\nsocket = "/run/j/agent.sock"\nadmin_socket = "/run/j/admin.sock"\n',
    );
    write(
      join(cwd, ".cops.toml"),
      '[daemon]\nsocket = "/tmp/mine.sock"\nadmin_socket = "/tmp/admin.sock"\n',
    );
    const { config, rejected } = load();
    expect(config.daemon.socket).toBe("/run/j/agent.sock");
    expect(config.daemon.adminSocket).toBe("/run/j/admin.sock");
    expect(rejected.map((r) => r.split(":")[0]).sort()).toEqual([
      "daemon.admin_socket",
      "daemon.socket",
    ]);
  });

  test("a relative admin socket resolves against its file's directory", () => {
    const flag = write(join(root, "flag.toml"), '[daemon]\nadmin_socket = "run/admin.sock"\n');
    expect(load({ configPath: flag }).config.daemon.adminSocket).toBe(
      join(root, "run", "admin.sock"),
    );
  });

  test("a longer hold token life from the repo is rejected; the user file may set it", () => {
    write(userFile(), "[daemon]\nhold_token_ttl_ms = 120000\n");
    write(join(cwd, ".cops.toml"), "[daemon]\nhold_token_ttl_ms = 86400000\n");
    const { config, rejected } = load();
    expect(config.daemon.holdTokenTtlMs).toBe(120_000);
    expect(rejected).toEqual([expect.stringContaining("daemon.hold_token_ttl_ms")]);
  });

  test("the git probe budget cannot be changed from the repo; the user file may set it", () => {
    write(userFile(), "[daemon]\ngit_probe_timeout_ms = 500\n");
    write(join(cwd, ".cops.toml"), "[daemon]\ngit_probe_timeout_ms = 1\n");
    const { config, rejected } = load();
    expect(config.daemon.gitProbeTimeoutMs).toBe(500);
    expect(rejected).toEqual([expect.stringContaining("daemon.git_probe_timeout_ms")]);
  });

  test("a repo value equal to the base is not a change", () => {
    write(join(cwd, ".cops.toml"), '[judge]\nprovider = "off"\n');
    expect(load().rejected).toEqual([]);
  });

  test("protectedPaths, privatePaths and the hook binary cannot be changed from the repo", () => {
    write(userFile(), '[policy]\nprotectedPaths = ["~/bin/tool"]\nprivatePaths = ["~/notes"]\n');
    write(
      join(cwd, ".cops.toml"),
      '[daemon]\nhook_binary = "/tmp/fake-hook"\n[policy]\nprotectedPaths = []\nprivatePaths = ["!~/.jev-cops"]\n',
    );
    const { config, rejected } = load();
    expect(config.policy.protectedPaths).toEqual(["~/bin/tool"]);
    expect(config.policy.privatePaths).toEqual(["~/notes"]);
    expect(config.daemon.hookBinary).toBeNull();
    expect(rejected.map((r) => r.split(":")[0]).sort()).toEqual([
      "daemon.hook_binary",
      "policy.privatePaths",
      "policy.protectedPaths",
    ]);
  });
});

describe("[daemon] hook_binary and the config files the daemon trusts", () => {
  test("hook_binary defaults to none and expands ~ when set", () => {
    expect(load().config.daemon.hookBinary).toBeNull();
    write(userFile(), '[daemon]\nhook_binary = "~/bin/cops-hook"\n');
    expect(load().config.daemon.hookBinary).toBe(join(home, "bin", "cops-hook"));
  });

  test("inputs: the user file even when absent, then $JEV_COPS_CONFIG and --config", () => {
    expect(load().inputs).toEqual([userFile()]);
    const envFile = write(join(root, "env.toml"), "");
    const flagFile = write(join(root, "flag.toml"), "");
    const both = load({ env: { JEV_COPS_CONFIG: envFile }, configPath: flagFile });
    expect(both.inputs).toEqual([userFile(), envFile, flagFile]);
  });

  test("inputs are absolute; the repo override is not one (config-tamper covers it)", () => {
    write(join(cwd, ".cops.toml"), '[enforcement]\nmode = "enforce"\n');
    const { inputs } = load({ env: { JEV_COPS_CONFIG: "not-yet/cops.toml" } });
    expect(inputs).toEqual([userFile(), resolve("not-yet/cops.toml")]);
  });
});

describe("validation", () => {
  test("bad TOML names the file", () => {
    const bad = write(join(root, "bad.toml"), "[judge\nprovider = ");
    expect(() => load({ configPath: bad })).toThrow(/bad\.toml.*TOML/);
  });

  test("unknown keys and wrong types are errors with the key path", () => {
    const bad = write(join(root, "bad.toml"), '[judge]\nprovder = "jev"\ntimeout_ms = "soon"\n');
    expect(() => load({ configPath: bad })).toThrow(/judge/);
  });

  test("an API key in the file is refused (keys come from the environment only)", () => {
    const bad = write(join(root, "bad.toml"), '[judge]\nprovider = "jev"\napi_key = "sk-1"\n');
    expect(() => load({ configPath: bad })).toThrow(/environment/);
  });

  test("unknown [context] / [policy] keys are errors, typed against the core defaults", () => {
    const typo = write(join(root, "t.toml"), "[context.budget]\nlimt = 5\n");
    expect(() => load({ configPath: typo })).toThrow(/context\.budget\.limt/);
    const wrong = write(join(root, "w.toml"), '[policy.bands]\nhold = "high"\n');
    expect(() => load({ configPath: wrong })).toThrow(/policy\.bands\.hold/);
  });

  test("open records in [context] accept any key", () => {
    const f = write(
      join(root, "ok.toml"),
      '[context.environment.hostClasses]\n"db.prod" = "prod"\n',
    );
    expect(load({ configPath: f }).config.context).toEqual({
      environment: { hostClasses: { "db.prod": "prod" } },
    });
  });

  test("audit forward is parsed", () => {
    const f = write(
      join(root, "f.toml"),
      '[audit.forward]\nkind = "file"\ntarget = "copy.jsonl"\n',
    );
    expect(load({ configPath: f }).config.audit.forward).toMatchObject({
      kind: "file",
      target: join(root, "copy.jsonl"),
    });
  });

  test("http must bind a loopback address (T13)", () => {
    const f = write(join(root, "h.toml"), '[daemon]\nhttp = "0.0.0.0:8080"\n');
    expect(() => load({ configPath: f })).toThrow(/loopback/);
    const ok = write(join(root, "ok.toml"), '[daemon]\nhttp = "127.0.0.1:0"\n');
    expect(load({ configPath: ok }).config.daemon.http).toEqual({ host: "127.0.0.1", port: 0 });
  });
});

describe("parseHttpBind", () => {
  test("accepts loopback hosts only", () => {
    expect(parseHttpBind("127.0.0.1:7777")).toEqual({
      ok: true,
      value: { host: "127.0.0.1", port: 7777 },
    });
    expect(parseHttpBind("localhost:1").ok).toBe(true);
    expect(parseHttpBind("[::1]:1")).toEqual({ ok: true, value: { host: "::1", port: 1 } });
    expect(parseHttpBind("0.0.0.0:1").ok).toBe(false);
    expect(parseHttpBind("10.0.0.2:1").ok).toBe(false);
    expect(parseHttpBind("127.0.0.1").ok).toBe(false);
    expect(parseHttpBind("127.0.0.1:70000").ok).toBe(false);
  });
});
