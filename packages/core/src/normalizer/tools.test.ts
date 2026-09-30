import { describe, expect, test } from "bun:test";
import { loadEventFixture } from "../../../../tests/fixtures/events/index.ts";
import { type Event, HARNESSES, parseEvent } from "../schema/event.ts";
import { normalize } from "./normalize.ts";
import {
  canonicalTool,
  HARNESS_TOOL_ALIASES,
  HARNESS_TOOL_RULES,
  isInertTool,
  mcpServer,
  TOOL_ALIASES,
  TOOL_RULES,
  toolRule,
} from "./tools.ts";

const HOME = "/home/dev";
const OPTS = { home: HOME };

type Json = Record<string, unknown>;

function call(tool: string, input: Json, kind = "other"): Event {
  const base = loadEventFixture("pre-bash") as Json;
  const parsed = parseEvent({ ...base, call: { ...(base.call as Json), tool, kind, input } });
  if (!parsed.ok) throw new Error(parsed.error.message);
  return parsed.value;
}

/** The inert tools of PLAN-M1 §4.1, plus CronDelete and CronList. */
const INERT = [
  ...["TaskCreate", "TaskGet", "TaskList", "TaskUpdate", "TodoWrite", "TaskOutput", "TaskStop"],
  ...["ToolSearch", "WaitForMcpServers", "ListAgents", "ListMcpResourcesTool"],
  ...["ReadMcpResourceTool", "AskUserQuestion", "EnterPlanMode", "ExitPlanMode"],
  ...["ScheduleWakeup", "ReportFindings", "SubagentHandback", "LSP", "SendMessage"],
  ...["Skill", "SendFeedback", "CronDelete", "CronList"],
];

describe("tool table: Claude Code names (tools-reference, v2.1.285)", () => {
  test("canonicalTool maps Claude Code names onto the context engine's names", () => {
    const names = ["Agent", "Task", "MultiEdit", "NotebookEdit", "PowerShell", "Monitor", "Glob"];
    expect(names.map((t) => canonicalTool(t))).toEqual([
      "Task",
      "Task",
      "Edit",
      "Edit",
      "Bash",
      "Bash",
      "Glob",
    ]);
  });

  test("MCP tools map to the spec form mcp:<server>:<tool>", () => {
    expect(canonicalTool("mcp__github__create_issue")).toBe("mcp:github:create_issue");
    expect(canonicalTool("mcp__plugin_a-b_srv__do__it")).toBe("mcp:plugin_a-b_srv:do__it");
    expect(canonicalTool("mcp:github:create_issue")).toBe("mcp:github:create_issue");
    expect(canonicalTool("mcp__broken")).toBe("mcp__broken");
  });

  test("mcpServer reads the server from either spelling; null for other tools", () => {
    expect(mcpServer("mcp__github__create_issue")).toBe("github");
    expect(mcpServer("mcp:github:create_issue")).toBe("github");
    expect(["Bash", "mcp__broken", "mcp:", "mcp::t"].map((t) => mcpServer(t))).toEqual([
      null,
      null,
      null,
      null,
    ]);
  });

  test("every bookkeeping tool of the plan is inert, and nothing else is", () => {
    expect(INERT.filter((t) => !isInertTool(t))).toEqual([]);
    expect(INERT.filter((t) => !isInertTool(t, "claude-code"))).toEqual([]);
    const other = ["Bash", "Write", "Agent", "todowrite", "mcp__x__y", "Unknown"];
    expect(other.some((t) => isInertTool(t))).toBe(false);
  });

  test("worktree tools change the disk, so they are not inert and fail closed (D-081)", () => {
    expect(["EnterWorktree", "ExitWorktree"].some((t) => isInertTool(t))).toBe(false);
  });

  test("the table lists every Claude Code tool with a side effect or a read", () => {
    const expected = [
      ...["Agent", "Artifact", "Bash", "CronCreate", "Edit", "Glob", "Grep", "Monitor"],
      ...["MultiEdit", "NotebookEdit", "PowerShell", "PushNotification", "Read"],
      ...["RemoteTrigger", "SendUserFile", "ShareOnboardingGuide", "Task", "WebFetch"],
      ...["WebSearch", "Workflow", "Write"],
    ];
    expect(expected.filter((t) => TOOL_RULES[t] === undefined)).toEqual([]);
  });
});

describe("normalize: Claude Code tools", () => {
  test("Agent is spawn and keeps prompt and description in raw", async () => {
    const input = { description: "Find endpoints", prompt: "Find all API endpoints" };
    const n = await normalize(call("Agent", input, "spawn"), OPTS);
    expect(n).toMatchObject({ kind: "spawn", raw: JSON.stringify(input), paths: [] });
    expect(n.commands[0]?.verbs).toEqual(["agent"]);
  });

  test.each(["Workflow", "CronCreate"])("%s is spawn", async (tool) => {
    expect((await normalize(call(tool, { prompt: "x" }), OPTS)).kind).toBe("spawn");
  });

  test("Monitor with a command is parsed as bash and runs in the background", async () => {
    const command = "tail -f /var/log/app.log";
    const n = await normalize(call("Monitor", { command, description: "watch" }, "exec"), OPTS);
    expect(n).toMatchObject({ kind: "spawn", raw: command, paths: ["/var/log/app.log"] });
    expect(n.commands[0]?.verbs).toEqual(["tail", "background"]);
  });

  test("Monitor with a ws source is net to the socket's host", async () => {
    const input = { ws: { url: "wss://events.example/feed" }, description: "feed" };
    const n = await normalize(call("Monitor", input), OPTS);
    expect(n).toMatchObject({ kind: "net", hosts: ["events.example"], raw: JSON.stringify(input) });
  });

  test("Monitor with neither command nor ws fails closed as an opaque exec", async () => {
    const n = await normalize(call("Monitor", { description: "?" }), OPTS);
    expect(n.kind).toBe("exec");
    expect(n.opaque.map((o) => o.reason)).toEqual(["parse-error"]);
  });

  test("PowerShell is an opaque interpreter exec over input.command", async () => {
    const command = "Set-Content -Path x.txt -Value hi";
    const n = await normalize(call("PowerShell", { command }, "exec"), OPTS);
    expect(n).toMatchObject({ kind: "exec", raw: command, paths: [] });
    expect(n.opaque).toEqual([{ reason: "interpreter", span: command }]);
  });

  test.each(["Glob", "Grep"])(
    "%s is fs.read on input.path; the pattern is not a path",
    async (t) => {
      const n = await normalize(call(t, { pattern: "**/*.pem", path: "~/.ssh" }), OPTS);
      expect(n).toMatchObject({ kind: "fs.read", paths: [`${HOME}/.ssh`] });
      const bare = await normalize(call(t, { pattern: "TODO" }), OPTS);
      expect(bare).toMatchObject({ kind: "fs.read", paths: [] });
    },
  );

  test("NotebookEdit prefers notebook_path over file_path", async () => {
    const input = { notebook_path: "/n/a.ipynb", file_path: "/n/b.ipynb", new_source: "x" };
    const n = await normalize(call("NotebookEdit", input, "fs.write"), OPTS);
    expect(n).toMatchObject({ kind: "fs.write", paths: ["/n/a.ipynb"] });
  });

  test("WebSearch is net with no host: the query is not a URL", async () => {
    const n = await normalize(call("WebSearch", { query: "https://evil.example docs" }), OPTS);
    expect(n).toMatchObject({ kind: "net", hosts: [], paths: [] });
    expect(n.commands[0]?.verbs).toEqual(["websearch"]);
  });

  test.each([
    "Artifact",
    "SendUserFile",
    "PushNotification",
    "RemoteTrigger",
    "ShareOnboardingGuide",
  ])("%s is net: data leaves the machine", async (tool) => {
    const n = await normalize(call(tool, { file_path: "/work/repo/report.html" }), OPTS);
    expect(n).toMatchObject({ kind: "net", hosts: [], paths: [] });
  });

  test.each(INERT)("%s is inert: kind other, verb inert, no targets", async (tool) => {
    const n = await normalize(call(tool, { todos: [{ content: "rm -rf /", path: "/etc" }] }), OPTS);
    expect(n).toMatchObject({ kind: "other", paths: [], hosts: [], opaque: [] });
    expect(n.commands.map((c) => c.verbs)).toEqual([["inert"]]);
  });

  test("an MCP tool is other and records its server; a command in it is not parsed", async () => {
    const input = { command: "rm -rf /", title: "x" };
    const n = await normalize(call("mcp__github__create_issue", input, "exec"), OPTS);
    expect(n).toMatchObject({ kind: "other", paths: [], raw: JSON.stringify(input) });
    expect(n.commands.map((c) => c.verbs)).toEqual([["mcp", "mcp:github"]]);
  });
});

describe("normalize: run_in_background", () => {
  test("adds the background verb and makes an exec a spawn", async () => {
    const n = await normalize(
      call("Bash", { command: "npm run dev", run_in_background: true }, "exec"),
      OPTS,
    );
    expect(n.kind).toBe("spawn");
    expect(n.commands[0]?.verbs).toEqual(["npm", "run", "background"]);
  });

  test("keeps a more severe kind and marks every command", async () => {
    const command = "rm -rf build && npm run build";
    const n = await normalize(call("Bash", { command, run_in_background: true }, "exec"), OPTS);
    expect(n.kind).toBe("fs.delete");
    expect(n.commands.every((c) => c.verbs.includes("background"))).toBe(true);
  });

  test("a shell & already in the command is not doubled", async () => {
    const n = await normalize(
      call("Bash", { command: "sleep 5 &", run_in_background: true }, "exec"),
      OPTS,
    );
    expect(n.commands[0]?.verbs).toEqual(["sleep", "background"]);
  });

  test("false or absent changes nothing; the state hash tells them apart", async () => {
    const fg = await normalize(call("Bash", { command: "npm run dev" }, "exec"), OPTS);
    const no = await normalize(
      call("Bash", { command: "npm run dev", run_in_background: false }, "exec"),
      OPTS,
    );
    const bg = await normalize(
      call("Bash", { command: "npm run dev", run_in_background: true }, "exec"),
      OPTS,
    );
    expect([fg.kind, no.kind]).toEqual(["exec", "exec"]);
    expect(fg.stateHash).toBe(no.stateHash);
    expect(bg.stateHash).not.toBe(fg.stateHash);
  });

  test("an opaque PowerShell in the background stays exec with the verb", async () => {
    const n = await normalize(
      call("PowerShell", { command: "Start-Job { x }", run_in_background: true }, "exec"),
      OPTS,
    );
    expect(n.kind).toBe("exec");
    expect(n.commands[0]?.verbs).toContain("background");
  });
});

describe("tool table by harness: (harness, tool) → rule", () => {
  test("the Pi/OpenCode collision: the same lower-case names read different fields", () => {
    for (const tool of ["read", "write", "edit"]) {
      expect(toolRule(tool, "pi")).toMatchObject({ reader: "path", fields: ["path"] });
      expect(toolRule(tool, "opencode")).toMatchObject({ reader: "path", fields: ["filePath"] });
    }
    expect(toolRule("grep", "pi")).toEqual(toolRule("grep", "opencode"));
    expect(toolRule("bash", "pi")).toEqual({ reader: "bash" });
    expect(toolRule("bash", "opencode")).toEqual({ reader: "bash", workdir: "workdir" });
  });

  test("a harness never reads another harness's names", () => {
    const foreign = [
      ["Read", "pi"],
      ["Bash", "pi"],
      ["bash", "claude-code"],
      ["read", "claude-code"],
      ["apply_patch", "claude-code"],
      ["Read", "codex"],
      ["Write", "codex"],
      ["read", "codex"],
      ["Write", "opencode"],
      ["find", "opencode"],
      ["ls", "opencode"],
      ["glob", "pi"],
      ["apply_patch", "pi"],
    ] as const;
    expect(foreign.filter(([tool, harness]) => toolRule(tool, harness) !== undefined)).toEqual([]);
  });

  test("Claude Code's table is the M1 table's capitalized half, unchanged", () => {
    const capitalized = Object.keys(TOOL_RULES).filter((t) => /^[A-Z]/.test(t));
    expect(Object.keys(HARNESS_TOOL_RULES["claude-code"]).sort()).toEqual(capitalized.sort());
  });

  test("without a harness the lookup is the M1 table (Claude Code and Pi), unchanged", () => {
    expect(TOOL_RULES).toEqual({ ...HARNESS_TOOL_RULES["claude-code"], ...HARNESS_TOOL_RULES.pi });
    expect(toolRule("read")).toEqual(toolRule("read", "pi"));
    expect(toolRule("Read")).toEqual(toolRule("Read", "claude-code"));
    const later = ["apply_patch", "todowrite", "glob", "webfetch"].map((t) => toolRule(t));
    expect(later).toEqual([undefined, undefined, undefined, undefined]);
  });

  test("canonicalTool maps each harness's names onto the context engine's", () => {
    const opencode = ["bash", "read", "write", "edit", "glob", "grep", "task", "apply_patch"];
    expect(opencode.map((t) => canonicalTool(t, "opencode"))).toEqual([
      ...["Bash", "Read", "Write", "Edit", "Glob", "Grep", "Task", "Edit"],
    ]);
    const more = ["webfetch", "websearch", "execute", "lsp", "github_create_issue"];
    expect(more.map((t) => canonicalTool(t, "opencode"))).toEqual([
      ...["WebFetch", "WebSearch", "Bash", "lsp", "github_create_issue"],
    ]);
    const codex = ["Bash", "apply_patch", "spawn_agent", "view_image", "mcp__fs__read_file"];
    expect(codex.map((t) => canonicalTool(t, "codex"))).toEqual([
      ...["Bash", "Edit", "Task", "Read", "mcp:fs:read_file"],
    ]);
    expect(["bash", "find", "ls", "glob"].map((t) => canonicalTool(t, "pi"))).toEqual([
      ...["Bash", "Glob", "Glob", "glob"],
    ]);
    expect(["Agent", "bash", "apply_patch"].map((t) => canonicalTool(t, "claude-code"))).toEqual([
      ...["Task", "bash", "apply_patch"],
    ]);
  });

  test("without a harness the aliases are the M1 ones", () => {
    const m1 = { ...HARNESS_TOOL_ALIASES["claude-code"], ...HARNESS_TOOL_ALIASES.pi };
    expect(TOOL_ALIASES).toEqual(m1);
    expect(["apply_patch", "glob", "task"].map((t) => canonicalTool(t))).toEqual([
      ...["apply_patch", "glob", "task"],
    ]);
  });

  test("inert tools are inert only on their own harness", () => {
    expect(isInertTool("todowrite", "opencode")).toBe(true);
    expect(isInertTool("update_plan", "codex")).toBe(true);
    expect(isInertTool("TodoWrite", "claude-code")).toBe(true);
    expect(isInertTool("todowrite", "pi")).toBe(false);
    expect(isInertTool("TodoWrite", "codex")).toBe(false);
    expect(isInertTool("update_plan", "opencode")).toBe(false);
    expect(isInertTool("update_plan")).toBe(false);
  });

  test("nothing that writes disk, spawns or runs code is inert on any harness (D-081)", () => {
    const risky = ["bash", "Bash", "apply_patch", "write", "edit", "execute", "task"].concat([
      ...["spawn_agent", "skill", "request_plugin_install", "request_permissions"],
      ...["write_stdin", "EnterWorktree", "invalid", "read_mcp_resource"],
    ]);
    for (const harness of HARNESSES) {
      expect(risky.filter((t) => isInertTool(t, harness))).toEqual([]);
    }
  });
});
