import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { readAudit } from "./audit.ts";
import { DEFAULT_DAEMON_CONFIG } from "./config.ts";
import { applyArgs, DAEMON_USAGE, main, parseDaemonArgs } from "./main.ts";
import { policyModule } from "./testing/policies.ts";

describe("parseDaemonArgs", () => {
  test("flags map onto overrides", () => {
    const r = parseDaemonArgs([
      "--config",
      "a.toml",
      "--socket",
      "/s",
      "--admin-socket",
      "/a",
      "--http",
      "127.0.0.1:9",
      "--enforce",
    ]);
    expect(r).toEqual({
      ok: true,
      value: {
        help: false,
        configPath: "a.toml",
        socket: "/s",
        adminSocket: "/a",
        http: { host: "127.0.0.1", port: 9 },
        mode: "enforce",
      },
    });
  });

  test("--observe and --enforce together are a usage error", () => {
    expect(parseDaemonArgs(["--observe", "--enforce"]).ok).toBe(false);
  });

  test("a non-loopback --http is a usage error (T13)", () => {
    expect(parseDaemonArgs(["--http", "0.0.0.0:1"]).ok).toBe(false);
  });

  test("unknown flags are a usage error", () => {
    expect(parseDaemonArgs(["--frobnicate"]).ok).toBe(false);
  });
});

describe("applyArgs", () => {
  test("--socket and --admin-socket override the config, resolved to absolute paths", () => {
    const args = { help: false, socket: "rel/d.sock", adminSocket: "rel/a.sock" };
    const applied = applyArgs(DEFAULT_DAEMON_CONFIG, args);
    expect(applied.daemon.socket).toBe(resolve("rel/d.sock"));
    expect(applied.daemon.adminSocket).toBe(resolve("rel/a.sock"));
    expect(applyArgs(DEFAULT_DAEMON_CONFIG, { help: false }).daemon).toEqual(
      DEFAULT_DAEMON_CONFIG.daemon,
    );
  });
});

describe("copsd process", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "jvm-"));
    mkdirSync(join(dir, "policies"));
    writeFileSync(join(dir, "policies", "ok.ts"), policyModule("ok"));
    writeFileSync(
      join(dir, "j.toml"),
      [
        "[daemon]",
        `socket = "${join(dir, "d.sock")}"`,
        `admin_socket = "${join(dir, "a.sock")}"`,
        "[policies]",
        `dir = "${join(dir, "policies")}"`,
        "[audit]",
        `path = "${join(dir, "audit.jsonl")}"`,
        "[store]",
        `path = "${join(dir, "s.sqlite")}"`,
        "",
      ].join("\n"),
    );
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  test("boots, prints one boot line with the loud warnings, and exits 0 on SIGTERM", async () => {
    const proc = Bun.spawn(
      ["bun", join(import.meta.dir, "main.ts"), "--config", join(dir, "j.toml")],
      { cwd: dir, env: { ...process.env, HOME: dir }, stderr: "pipe", stdout: "pipe" },
    );
    const socket = join(dir, "d.sock");
    const deadline = Date.now() + 10_000;
    let healthy = false;
    while (!healthy && Date.now() < deadline) {
      await Bun.sleep(50);
      healthy =
        existsSync(socket) &&
        (await fetch("http://localhost/v1/health", { unix: socket }).then(
          (r) => r.ok,
          () => false,
        ));
    }
    expect(healthy).toBe(true);
    proc.kill("SIGTERM");
    expect(await proc.exited).toBe(0);
    const stderr = await new Response(proc.stderr).text();
    expect(stderr).toContain(`copsd listening on ${socket}`);
    expect(stderr).toContain(`admin ${join(dir, "a.sock")}`);
    expect(stderr).toContain("1 policy");
    expect(stderr).toContain("judge off");
    expect(stderr).toContain("WARNING: enforcement = observe");
    expect(stderr).toContain("WARNING: judge = off");
    const lines = readAudit(join(dir, "audit.jsonl")).lines;
    expect(lines.map((l) => l.payload.event)).toEqual(["boot", "shutdown"]);
    const config = lines[0]?.payload.config as { policy: { protectedPaths: string[] } } | undefined;
    expect(config?.policy.protectedPaths).toContain(join(dir, "j.toml"));
    expect(existsSync(socket)).toBe(false);
    expect(existsSync(join(dir, "a.sock"))).toBe(false);
  });

  test("a broken config exits 1 with the reason", async () => {
    writeFileSync(join(dir, "bad.toml"), "[judge]\nprovider = 'nope'\n");
    const proc = Bun.spawn(
      ["bun", join(import.meta.dir, "main.ts"), "--config", join(dir, "bad.toml")],
      {
        cwd: dir,
        env: { ...process.env, HOME: dir },
        stderr: "pipe",
      },
    );
    expect(await proc.exited).toBe(1);
    expect(await new Response(proc.stderr).text()).toContain("bad.toml");
  });
});

describe("main, in process", () => {
  let dir: string;
  let out: string[];
  let err: string[];
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "jvi-"));
    mkdirSync(join(dir, "policies"));
    writeFileSync(join(dir, "policies", "ok.ts"), policyModule("ok"));
    out = [];
    err = [];
    spyOn(process.stdout, "write").mockImplementation((c: string | Uint8Array) => {
      out.push(String(c));
      return true;
    });
    spyOn(process.stderr, "write").mockImplementation((c: string | Uint8Array) => {
      err.push(String(c));
      return true;
    });
  });
  afterEach(() => {
    for (const s of [process.stdout, process.stderr]) {
      (s.write as unknown as { mockRestore(): void }).mockRestore();
    }
    rmSync(dir, { recursive: true, force: true });
  });

  function config(): string {
    const file = join(dir, "j.toml");
    const lines = [
      "[daemon]",
      `socket = "${join(dir, "d.sock")}"`,
      `admin_socket = "${join(dir, "a.sock")}"`,
      "http = false",
      "[judge]",
      'provider = "off"',
      "[policies]",
      `dir = "${join(dir, "policies")}"`,
      "[audit]",
      `path = "${join(dir, "audit.jsonl")}"`,
      "[store]",
      `path = "${join(dir, "s.sqlite")}"`,
    ];
    writeFileSync(file, `${lines.join("\n")}\n`);
    return file;
  }

  test("--help prints the usage and exits 0; a bad flag exits 2 with the usage", async () => {
    expect(await main(["--help"])).toBe(0);
    expect(out.join("")).toBe(`${DAEMON_USAGE}\n`);
    expect(await main(["--frobnicate"])).toBe(2);
    expect(err.join("")).toContain(DAEMON_USAGE);
  });

  test("a config that cannot be loaded exits 1 with the reason", async () => {
    expect(await main(["--config", join(dir, "missing.toml")])).toBe(1);
    expect(err.join("")).toContain("missing.toml: config file not found");
  });

  test("boots, prints the boot line and warnings, and stops cleanly on SIGTERM", async () => {
    const exited = main(["--config", config(), "--enforce"]);
    const socket = join(dir, "d.sock");
    const deadline = Date.now() + 5_000;
    while (!err.join("").includes("copsd listening") && Date.now() < deadline) {
      await Bun.sleep(10);
    }
    expect(err.join("")).toContain(`copsd listening on ${socket}`);
    expect(err.join("")).toContain("enforcement enforce");
    expect(err.join("")).toMatch(/ · \d+ protected paths/);
    expect(err.join("")).toContain("WARNING: judge = off");
    expect(process.listeners("SIGTERM")).toHaveLength(1);
    process.emit("SIGTERM");
    expect(await exited).toBe(0);
    expect(process.listeners("SIGTERM")).toHaveLength(0);
    expect(process.listeners("SIGINT")).toHaveLength(0);
    expect(existsSync(socket)).toBe(false);
  });

  test("SIGINT stops it too; an injected stop replaces the signals", async () => {
    const exited = main(["--config", config()]);
    const deadline = Date.now() + 5_000;
    while (!err.join("").includes("copsd listening") && Date.now() < deadline) {
      await Bun.sleep(10);
    }
    process.emit("SIGINT");
    expect(await exited).toBe(0);
    expect(process.listeners("SIGTERM")).toHaveLength(0);
    expect(await main(["--config", config()], async () => undefined)).toBe(0);
    expect(existsSync(join(dir, "a.sock"))).toBe(false);
  });
});
