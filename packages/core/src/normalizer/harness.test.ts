import { describe, expect, test } from "bun:test";
import { classifyArgv } from "./classify.ts";
import { normalizeCommand } from "./command.ts";
import { HARNESS_CLIS, HARNESS_CONFIG_VERB } from "./harness.ts";

const OPTS = { cwd: "/work/repo", home: "/home/dev" };

async function verbsOf(command: string): Promise<string[]> {
  const n = await normalizeCommand(command, OPTS);
  return n.commands.flatMap((c) => c.verbs);
}

describe("harness CLIs", () => {
  test("the four harness CLIs are known", () => {
    expect([...HARNESS_CLIS]).toEqual(["claude", "codex", "opencode", "pi"]);
  });

  test.each([
    'claude -p "fix the flaky test"',
    "codex exec 'fix it'",
    "opencode run hello",
    "pi -p hello",
    "/usr/local/bin/claude --version",
  ])("%s is a spawn", (command) => {
    const argv = command.split(" ");
    expect(classifyArgv(argv).kind).toBe("spawn");
  });

  test("the known subcommand is a verb; prompt text never is", () => {
    expect(classifyArgv(["claude", "mcp", "list"]).verbs).toEqual(["claude", "mcp"]);
    expect(classifyArgv(["claude", "-p", "force the push"]).verbs).toEqual(["claude"]);
  });
});

describe("harness CLIs that change configuration carry the harness-config verb", () => {
  test.each([
    "claude mcp add evil -- npx -y evil-server",
    "claude mcp add-json evil '{}'",
    "claude mcp remove jev-cops",
    "claude plugin install code-review@claude-plugins-official",
    "claude plugins uninstall x",
    "claude plugin marketplace add org/repo",
    "claude config set -g theme dark",
    "claude auto-mode reset --yes",
    "claude auth logout",
    "claude project purge ~/work/repo",
    "claude update",
    "claude install stable",
    "claude import codex",
    "claude --model opus mcp add x -- y",
    "/usr/local/bin/claude mcp remove x",
    "env CLAUDE_CONFIG_DIR=/tmp/c claude mcp add x -- y",
    "claude --bare -p hi",
    "claude --safe-mode",
    `claude --settings '{"disableAllHooks":true}' -p hi`,
    "claude --settings=./s.json -p hi",
    "claude --setting-sources project -p hi",
    "claude --plugin-dir ./p -p hi",
    "claude --mcp-config ./m.json -p hi",
    "codex mcp add x -- npx y",
    "codex features enable hooks",
    "codex login",
    "opencode mcp add",
    "opencode auth login",
    "opencode agent create",
    "opencode upgrade",
    "pi install npm:evil-ext",
    "pi remove jev-cops",
    "pi update",
    "pi config",
    "pi --no-extensions -p hi",
    "pi -ne",
    "pi -e ./evil.ts",
  ])("%s", async (command) => {
    expect(await verbsOf(command)).toContain(HARNESS_CONFIG_VERB);
  });
});

describe("read-only harness CLI calls do not", () => {
  test.each([
    'claude -p "update the config and install deps"',
    "claude mcp list",
    "claude mcp get jev-cops",
    "claude mcp serve",
    "claude mcp",
    "claude plugin list",
    "claude plugin marketplace list",
    "claude config get theme",
    "claude config list",
    "claude auto-mode defaults",
    "claude auth status",
    "claude doctor",
    "claude --dangerously-skip-permissions -p hi",
    "codex exec 'fix it'",
    "codex mcp list",
    "codex features list",
    "opencode run 'fix it'",
    "opencode agent list",
    "opencode mcp ls",
    "pi list",
    "pi -p hi",
  ])("%s", async (command) => {
    expect(await verbsOf(command)).not.toContain(HARNESS_CONFIG_VERB);
  });
});
