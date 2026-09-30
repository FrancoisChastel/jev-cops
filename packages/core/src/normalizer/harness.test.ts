import { describe, expect, test } from "bun:test";
import { loadEventFixture } from "../../../../tests/fixtures/events/index.ts";
import { parseEvent } from "../schema/event.ts";
import { classifyArgv } from "./classify.ts";
import { normalizeCommand } from "./command.ts";
import { HARNESS_CLIS, HARNESS_CONFIG_VERB } from "./harness.ts";
import { normalize } from "./normalize.ts";

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
    "codex plugin install x",
    "codex update",
    "codex --dangerously-bypass-hook-trust exec hi",
    "codex exec --ignore-rules hi",
    "codex exec --ignore-user-config hi",
    "codex --disable hooks",
    "codex --enable x exec hi",
    "codex -c features.hooks=false exec hi",
    "codex --config=features.hooks=false",
    "codex -p ci exec hi",
    "codex --profile ci",
    "codex --remote ws://h:1 hi",
    "opencode --pure run hi",
    "opencode run --pure hi",
    "opencode providers login",
    "opencode plug evil-plugin",
  ])("%s", async (command) => {
    expect(await verbsOf(command)).toContain(HARNESS_CONFIG_VERB);
  });
});

const RELOCATED = [
  "CODEX_HOME=/tmp/c codex exec hi",
  "env CODEX_HOME=/tmp/c codex exec hi",
  "OPENCODE_PURE=1 opencode run hi",
  "OPENCODE_CONFIG_DIR=/tmp/o opencode",
  "CLAUDE_CONFIG_DIR=/tmp/c claude -p hi",
  "PI_CODING_AGENT_DIR=/tmp/p pi -p hi",
  "HOME=/tmp/h claude -p hi",
  "bash -c 'CODEX_HOME=/tmp/c codex exec hi'",
];

describe("normalizeCommand sees config-relocating environment too", () => {
  test.each(RELOCATED)("%s", async (command) => {
    expect(await verbsOf(command)).toContain(HARNESS_CONFIG_VERB);
  });

  test("an unrelated variable on a harness CLI adds nothing", async () => {
    expect(await verbsOf("RUST_LOG=debug codex exec hi")).not.toContain(HARNESS_CONFIG_VERB);
  });
});

describe("config-relocating environment on a harness CLI adds harness-config (D-114 pattern)", () => {
  async function eventVerbs(command: string): Promise<string[]> {
    const base = loadEventFixture("pre-bash") as Record<string, unknown>;
    const call = { ...(base.call as object), tool: "Bash", kind: "exec", input: { command } };
    const parsed = parseEvent({ ...base, call });
    if (!parsed.ok) throw new Error(parsed.error.message);
    const n = await normalize(parsed.value, { home: OPTS.home });
    return n.commands.flatMap((c) => c.verbs);
  }

  test.each([
    "CODEX_HOME=/tmp/c codex exec hi",
    "env CODEX_HOME=/tmp/c codex exec hi",
    "OPENCODE_PURE=1 opencode run hi",
    "OPENCODE_DISABLE_PROJECT_CONFIG=1 opencode run hi",
    "OPENCODE_CONFIG=/tmp/o.json opencode run hi",
    "OPENCODE_CONFIG_DIR=/tmp/o opencode",
    `OPENCODE_CONFIG_CONTENT='{"plugin":[]}' opencode run hi`,
    "CLAUDE_CONFIG_DIR=/tmp/c claude -p hi",
    "PI_CODING_AGENT_DIR=/tmp/p pi -p hi",
    "XDG_CONFIG_HOME=/tmp/x opencode run hi",
    "HOME=/tmp/h claude -p hi",
    "timeout 60 env CODEX_HOME=/tmp/c codex exec hi",
    "bash -c 'CODEX_HOME=/tmp/c codex exec hi'",
  ])("%s", async (command) => {
    expect(await eventVerbs(command)).toContain(HARNESS_CONFIG_VERB);
  });

  test.each([
    "CODEX_HOME=/tmp/c claude -p hi",
    "PI_CODING_AGENT_DIR=/tmp/p codex exec hi",
    "RUST_LOG=debug codex exec hi",
    "CODEX_HOME=/tmp/c ls",
    "OPENCODE_PURE=1 git status",
  ])("%s does not", async (command) => {
    expect(await eventVerbs(command)).not.toContain(HARNESS_CONFIG_VERB);
  });

  test("the verb is added once, even when a flag already set it", async () => {
    const verbs = await eventVerbs("CODEX_HOME=/tmp/c codex --disable hooks");
    expect(verbs.filter((v) => v === HARNESS_CONFIG_VERB)).toHaveLength(1);
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
