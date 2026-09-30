import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import {
  daemonHealth,
  installedDaemonEntry,
  processRunner,
  processServiceContext,
} from "./context.ts";

describe("processServiceContext", () => {
  test("the real home unless --home names another, resolved against the cwd", () => {
    const real = processServiceContext();
    expect(real.home).toBe(homedir());
    expect(real.realHome).toBe(homedir());
    expect(real.platform).toBe(process.platform);
    expect(real.launchctl).toBe("/bin/launchctl");
    expect(real.systemctl).toMatch(/^\/(usr\/)?bin\/systemctl$/);
    const other = processServiceContext("some/dir");
    expect(other.home).toBe(resolve("some/dir"));
    expect(other.realHome).toBe(homedir());
  });

  test("the daemon entry resolves to the installed @jev-cops/daemon main module", () => {
    expect(installedDaemonEntry()).toMatch(/daemon\/src\/main\.ts$/);
  });
});

describe("processRunner", () => {
  test("exec form with a fixed PATH and only the user-manager variables", async () => {
    const run = processRunner("/Users/me", {
      PATH: "/evil/bin:/usr/bin",
      XDG_RUNTIME_DIR: "/run/user/1000",
      SECRET: "x",
    });
    const r = await run(["/usr/bin/env"]);
    expect(r.code).toBe(0);
    const vars = r.stdout.split("\n").filter((l) => l !== "");
    expect(vars.sort()).toEqual([
      "HOME=/Users/me",
      "PATH=/usr/bin:/bin:/usr/sbin:/sbin",
      "XDG_RUNTIME_DIR=/run/user/1000",
    ]);
  });

  test("a program that cannot start has no exit code and says why", async () => {
    const r = await processRunner("/Users/me", {})(["/nonexistent/launchctl", "print"]);
    expect(r.code).toBeNull();
    expect(r.stderr.length).toBeGreaterThan(0);
  });
});

describe("daemonHealth", () => {
  let home: string;
  let sockets: string;

  beforeEach(() => {
    home = mkdtempSync("/tmp/jvsvc-home-");
    sockets = mkdtempSync("/tmp/jvsvc-s-");
    mkdirSync(join(home, ".config", "jev-cops"), { recursive: true });
    writeFileSync(
      join(home, ".config", "jev-cops", "cops.toml"),
      `[daemon]\nsocket = "${sockets}/a.sock"\nadmin_socket = "${sockets}/b.sock"\n`,
    );
  });
  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
    rmSync(sockets, { recursive: true, force: true });
  });

  function serve(name: string, status = 200) {
    return Bun.serve({ unix: join(sockets, name), fetch: () => new Response("{}", { status }) });
  }

  test("both configured sockets answering /v1/health is healthy", async () => {
    const servers = [serve("a.sock"), serve("b.sock")];
    try {
      const r = await daemonHealth(home, 2_000);
      expect(r).toEqual({
        ok: true,
        detail: `copsd answers /v1/health on ${sockets}/a.sock and ${sockets}/b.sock`,
      });
    } finally {
      for (const s of servers) s.stop(true);
    }
  });

  test("a socket that never answers 200 fails at the deadline", async () => {
    const servers = [serve("a.sock"), serve("b.sock", 503)];
    try {
      const started = Date.now();
      const r = await daemonHealth(home, 400);
      expect(r).toEqual({ ok: false, detail: `no answer on ${sockets}/b.sock within 400 ms` });
      expect(Date.now() - started).toBeLessThan(2_000);
    } finally {
      for (const s of servers) s.stop(true);
    }
  });

  test("a config copsd cannot load fails at once, naming it", async () => {
    writeFileSync(join(home, ".config", "jev-cops", "cops.toml"), "[nope]\nx = 1\n");
    const r = await daemonHealth(home, 5_000);
    expect(r.ok).toBe(false);
    expect(r.detail).toStartWith("copsd cannot start: ");
  });
});
