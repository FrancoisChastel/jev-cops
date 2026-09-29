import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readAudit } from "./audit.ts";
import { parseDaemonArgs } from "./main.ts";
import { policyModule } from "./testing/policies.ts";

describe("parseDaemonArgs", () => {
  test("flags map onto overrides", () => {
    const r = parseDaemonArgs([
      "--config",
      "a.toml",
      "--socket",
      "/s",
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

describe("jevdictd process", () => {
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
    expect(stderr).toContain(`jevdictd listening on ${socket}`);
    expect(stderr).toContain("1 policy");
    expect(stderr).toContain("judge off");
    expect(stderr).toContain("WARNING: enforcement = observe");
    expect(stderr).toContain("WARNING: judge = off");
    const kinds = readAudit(join(dir, "audit.jsonl")).lines.map((l) => l.payload.event);
    expect(kinds).toEqual(["boot", "shutdown"]);
    expect(existsSync(socket)).toBe(false);
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
