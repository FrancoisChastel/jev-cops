import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, realpathSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type GuardedFs, guardedFs } from "../testing/fs-guard.ts";
import { claudeVersion, restoreText, writeClaudeCodeState } from "./install-state.ts";
import type { SpawnRequest, SpawnResult } from "./spawn.ts";
import { type ClaudeCodeState, readHarnessVersion } from "./state.ts";

let home = "";
let fs: GuardedFs;
beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), "jvcc-st-")));
  fs = guardedFs([home]);
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

const NOW = new Date("2026-09-29T09:12:00.000Z");
const state = (over: Partial<ClaudeCodeState> = {}): ClaudeCodeState => ({
  claude_version: "2.1.285",
  installed_at: NOW.toISOString(),
  scope: "user",
  settings_path: join(home, ".claude", "settings.json"),
  hook_binary: "/opt/dist/cops-hook",
  socket: join(home, ".jev-cops", "copsd.sock"),
  ...over,
});
const reply = (over: Partial<SpawnResult>): SpawnResult => ({
  exitCode: 0,
  stdout: "",
  stderr: "",
  timedOut: false,
  error: null,
  ...over,
});

describe("writeClaudeCodeState", () => {
  test("writes the contract fields (0600 under a 0700 ~/.jev-cops) the hook reads back", () => {
    const out = writeClaudeCodeState(home, state(), { fs, now: NOW });
    expect(out.previous).toBeNull();
    expect(JSON.parse(readFileSync(out.path, "utf8"))).toEqual(state());
    expect(statSync(out.path).mode & 0o777).toBe(0o600);
    expect(statSync(join(home, ".jev-cops")).mode & 0o777).toBe(0o700);
    expect(readHarnessVersion(home)).toBe("2.1.285");
  });

  test("returns the previous text so a rollback can restore it", () => {
    const first = writeClaudeCodeState(home, state(), { fs, now: NOW });
    const before = readFileSync(first.path, "utf8");
    const second = writeClaudeCodeState(home, state({ claude_version: null }), { fs, now: NOW });
    expect(second.previous).toBe(before);
    restoreText(second.path, second.previous, 0o600, { fs, now: NOW });
    expect(readFileSync(second.path, "utf8")).toBe(before);
    restoreText(second.path, null, 0o600, { fs, now: NOW });
    expect(fs.exists(second.path)).toBe(false);
  });
});

describe("claudeVersion: `claude --version` under the given environment", () => {
  test("parses the version; asks with the injected HOME", async () => {
    const seen: SpawnRequest[] = [];
    const spawn = async (r: SpawnRequest) => {
      seen.push(r);
      return reply({ stdout: "2.1.285 (Claude Code)\n" });
    };
    expect(await claudeVersion(spawn, { PATH: "/p", HOME: home })).toBe("2.1.285");
    expect(seen[0]?.argv).toEqual(["claude", "--version"]);
    expect(seen[0]?.env.HOME).toBe(home);
  });

  test("not on PATH, failing or unparsable → null", async () => {
    expect(
      await claudeVersion(async () => reply({ exitCode: null, error: "not found" }), {}),
    ).toBeNull();
    expect(await claudeVersion(async () => reply({ exitCode: 1 }), {})).toBeNull();
    expect(await claudeVersion(async () => reply({ stdout: "weird" }), {})).toBeNull();
  });
});
