import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { HOOK_VERSION } from "@jev-cops/adapter-claude-code";
import { CLI_VERSION } from "../version.ts";
import { processContext, scopedEnv } from "./install-context.ts";

const REPO = join(import.meta.dir, "..", "..", "..", "..");

describe("processContext: the only place the real home is read", () => {
  test("reflects this process", () => {
    const ctx = processContext();
    expect(ctx.home).toBe(homedir());
    expect(ctx.cwd).toBe(process.cwd());
    expect(ctx.platform).toBe(process.platform);
    expect(ctx.now()).toBeInstanceOf(Date);
    expect(ctx.runtime.execPath).toBe(process.execPath);
  });

  test("no other install module reads os.homedir() (home is always injected)", () => {
    const files = [
      ...[
        "canary",
        "hook-binary",
        "hook-entries",
        "install",
        "install-state",
        "line-diff",
        "refusals",
        "settings",
        "settings-io",
        "settings-merge",
        "spawn",
        "state",
      ].map((f) => join(REPO, "adapters", "claude-code", "src", `${f}.ts`)),
      ...[
        "install",
        "install-args",
        "install-claude-code",
        "install-pi",
        "install-report",
        "install-setup",
      ].map((f) => join(REPO, "packages", "cli", "src", "commands", `${f}.ts`)),
      join(REPO, "packages", "cli", "src", "toml-key.ts"),
    ];
    const code = (file: string) =>
      readFileSync(file, "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/\/\/.*$/gm, "");
    for (const file of files) expect(code(file)).not.toContain("homedir");
  });

  test("the hook binary's version is the CLI's", () => {
    expect(HOOK_VERSION).toBe(CLI_VERSION);
  });
});

describe("scopedEnv: --home confines config locations", () => {
  const env = {
    PATH: "/usr/bin",
    CLAUDE_CONFIG_DIR: "/real/.claude",
    PI_CODING_AGENT_DIR: "/tmp/h/pi",
    JEV_COPS_CONFIG: "/etc/cops.toml",
  };

  test("without --home the environment is used as is", () => {
    expect(scopedEnv(env, "/tmp/h", false)).toEqual({ env, dropped: [] });
  });

  test("with --home, locations outside it are dropped", () => {
    const out = scopedEnv(env, "/tmp/h", true);
    expect(out.dropped).toEqual(["CLAUDE_CONFIG_DIR", "JEV_COPS_CONFIG"]);
    expect(out.env).toEqual({ PATH: "/usr/bin", PI_CODING_AGENT_DIR: "/tmp/h/pi" });
  });
});
