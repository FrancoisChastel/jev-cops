import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_DAEMON_CONFIG } from "@jev-cops/daemon";
import { configuredPaths } from "./config-paths.ts";

let dir: string;
let saved: string | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "jvcp-"));
  saved = process.env.JEV_COPS_CONFIG;
});

afterEach(() => {
  if (saved === undefined) delete process.env.JEV_COPS_CONFIG;
  else process.env.JEV_COPS_CONFIG = saved;
  rmSync(dir, { recursive: true, force: true });
});

describe("configuredPaths", () => {
  test("reads the audit log and both sockets with the daemon's precedence", () => {
    const file = join(dir, "j.toml");
    writeFileSync(
      file,
      [
        "[daemon]",
        `socket = "${join(dir, "agent.sock")}"`,
        `admin_socket = "${join(dir, "admin.sock")}"`,
        "[audit]",
        `path = "${join(dir, "audit.jsonl")}"`,
        "",
      ].join("\n"),
    );
    process.env.JEV_COPS_CONFIG = file;
    expect(configuredPaths()).toEqual({
      audit: join(dir, "audit.jsonl"),
      socket: join(dir, "agent.sock"),
      adminSocket: join(dir, "admin.sock"),
    });
  });

  test("an unloadable config falls back to the defaults (the CLI still reads logs)", () => {
    const bad = join(dir, "bad.toml");
    writeFileSync(bad, "[daemon\nsocket = ");
    process.env.JEV_COPS_CONFIG = bad;
    expect(configuredPaths()).toEqual({
      audit: DEFAULT_DAEMON_CONFIG.audit.path,
      socket: DEFAULT_DAEMON_CONFIG.daemon.socket,
      adminSocket: DEFAULT_DAEMON_CONFIG.daemon.adminSocket,
    });
  });
});
