import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "./config.ts";
import { parseHostPort } from "./config-audit.ts";

let root: string;
let home: string;
let cwd: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "jev-cops-caudit-"));
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

const load = (configPath?: string) =>
  loadConfig({ home, cwd, env: {}, ...(configPath === undefined ? {} : { configPath }) });

describe("[audit] defaults", () => {
  test("unsigned is allowed, every 100 lines, keys under ~/.jev-cops/keys and ~/.config", () => {
    expect(load().config.audit).toEqual({
      path: join(home, ".jev-cops", "audit.jsonl"),
      forward: null,
      checkpointEvery: 100,
      requireSigning: false,
      key: join(home, ".jev-cops", "keys", "audit-ed25519.key"),
      publicKey: join(home, ".config", "jev-cops", "audit-ed25519.pub"),
    });
  });
});

describe("[audit] settings", () => {
  test("checkpoint interval, signing requirement and key paths (relative to the file)", () => {
    const f = write(
      join(root, "c.toml"),
      '[audit]\ncheckpoint_every = 10\nrequire_signing = true\nkey = "k/a.key"\npublic_key = "~/a.pub"\n',
    );
    expect(load(f).config.audit).toMatchObject({
      checkpointEvery: 10,
      requireSigning: true,
      key: join(root, "k", "a.key"),
      publicKey: join(home, "a.pub"),
    });
  });

  test("a file forward: target and cursor resolved, cursor next to the log by default", () => {
    const f = write(
      join(root, "f.toml"),
      '[audit.forward]\nkind = "file"\ntarget = "copy.jsonl"\n',
    );
    expect(load(f).config.audit.forward).toEqual({
      kind: "file",
      target: join(root, "copy.jsonl"),
      required: false,
      maxLagLines: 1_000,
      maxLagMs: 60_000,
      cursor: join(home, ".jev-cops", "forward.cursor"),
      syslog: null,
    });
  });

  test("a syslog forward: TLS files resolved, RFC 5424 defaults", () => {
    const f = write(
      join(root, "s.toml"),
      [
        "[audit.forward]",
        'kind = "syslog"',
        'target = "siem.example:6514"',
        'ca_file = "ca.pem"',
        'cert_file = "client.pem"',
        'key_file = "client.key"',
        "required = true",
        "max_lag_lines = 50",
        "max_lag_ms = 5000",
        'cursor = "cur"',
        "",
      ].join("\n"),
    );
    expect(load(f).config.audit.forward).toEqual({
      kind: "syslog",
      target: "siem.example:6514",
      required: true,
      maxLagLines: 50,
      maxLagMs: 5_000,
      cursor: join(root, "cur"),
      syslog: {
        host: "siem.example",
        port: 6514,
        ca: join(root, "ca.pem"),
        cert: join(root, "client.pem"),
        key: join(root, "client.key"),
        serverName: null,
        facility: 16,
        appName: "copsd",
        enterpriseNumber: 32473,
        maxMessageBytes: 8_192,
        resendOverlap: 100,
      },
    });
  });

  test("syslog needs a CA file and a host:port target", () => {
    const noCa = write(
      join(root, "a.toml"),
      '[audit.forward]\nkind = "syslog"\ntarget = "siem.example:6514"\n',
    );
    expect(() => load(noCa)).toThrow(/ca_file/);
    const badTarget = write(
      join(root, "b.toml"),
      '[audit.forward]\nkind = "syslog"\ntarget = "siem.example"\nca_file = "ca.pem"\n',
    );
    expect(() => load(badTarget)).toThrow(/host:port/);
  });

  test("a forward without kind or target is refused", () => {
    const f = write(join(root, "k.toml"), "[audit.forward]\nrequired = true\n");
    expect(() => load(f)).toThrow(/audit\.forward needs kind/);
  });

  test("message size stays within RFC 5425 bounds; the facility must be known", () => {
    const small = write(
      join(root, "m.toml"),
      '[audit.forward]\nkind = "syslog"\ntarget = "h:1"\nca_file = "c"\nmax_message_bytes = 100\n',
    );
    expect(() => load(small)).toThrow(/max_message_bytes/);
    const fac = write(
      join(root, "n.toml"),
      '[audit.forward]\nkind = "syslog"\ntarget = "h:1"\nca_file = "c"\nfacility = "nope"\n',
    );
    expect(() => load(fac)).toThrow(/facility/);
  });
});

describe("repo override (.cops.toml): may only turn required / require_signing on", () => {
  test("require_signing and forward.required on are kept", () => {
    write(
      join(home, ".config", "jev-cops", "cops.toml"),
      '[audit.forward]\nkind = "file"\ntarget = "/srv/copy.jsonl"\n',
    );
    write(
      join(cwd, ".cops.toml"),
      "[audit]\nrequire_signing = true\n[audit.forward]\nrequired = true\n",
    );
    const { config, rejected } = load();
    expect(rejected).toEqual([]);
    expect(config.audit.requireSigning).toBe(true);
    expect(config.audit.forward?.required).toBe(true);
  });

  test("everything else in [audit] is rejected", () => {
    write(
      join(home, ".config", "jev-cops", "cops.toml"),
      '[audit]\nrequire_signing = true\n[audit.forward]\nkind = "file"\ntarget = "/srv/c"\nrequired = true\n',
    );
    write(
      join(cwd, ".cops.toml"),
      [
        "[audit]",
        "require_signing = false",
        "checkpoint_every = 1",
        'key = "/tmp/k"',
        "[audit.forward]",
        "required = false",
        'target = "/tmp/other"',
        "",
      ].join("\n"),
    );
    const { config, rejected } = load();
    expect(rejected).toHaveLength(5);
    expect(config.audit).toMatchObject({ requireSigning: true, checkpointEvery: 100 });
    expect(config.audit.forward).toMatchObject({ required: true, target: "/srv/c" });
  });

  test("a repo that requires forwarding where none is configured stops copsd from starting", () => {
    write(join(cwd, ".cops.toml"), "[audit.forward]\nrequired = true\n");
    expect(() => load()).toThrow(/audit\.forward needs kind/);
  });
});

describe("parseHostPort", () => {
  test("host:port and [ipv6]:port", () => {
    expect(parseHostPort("siem:6514")).toEqual({ ok: true, value: { host: "siem", port: 6514 } });
    expect(parseHostPort("[::1]:6514")).toEqual({ ok: true, value: { host: "::1", port: 6514 } });
    expect(parseHostPort("siem").ok).toBe(false);
    expect(parseHostPort("siem:0").ok).toBe(false);
    expect(parseHostPort("siem:70000").ok).toBe(false);
  });
});
