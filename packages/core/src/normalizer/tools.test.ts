import { describe, expect, test } from "bun:test";
import { loadEventFixture } from "../../../../tests/fixtures/events/index.ts";
import { type Event, parseEvent } from "../schema/event.ts";
import { normalize } from "./normalize.ts";
import { canonicalTool, isInertTool, mcpServer, TOOL_RULES } from "./tools.ts";

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
    expect(names.map(canonicalTool)).toEqual([
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
    expect(["Bash", "mcp__broken", "mcp:", "mcp::t"].map(mcpServer)).toEqual([
      null,
      null,
      null,
      null,
    ]);
  });

  test("every bookkeeping tool of the plan is inert, and nothing else is", () => {
    expect(INERT.filter((t) => !isInertTool(t))).toEqual([]);
    expect(["Bash", "Write", "Agent", "todowrite", "mcp__x__y", "Unknown"].some(isInertTool)).toBe(
      false,
    );
  });

  test("worktree tools change the disk, so they are not inert and fail closed (D-081)", () => {
    expect(["EnterWorktree", "ExitWorktree"].some(isInertTool)).toBe(false);
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
