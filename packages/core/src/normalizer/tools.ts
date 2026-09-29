import type { CallKind } from "../schema/event.ts";
import { lookup } from "./options.ts";
import type { PathAccess } from "./types.ts";

/**
 * How one tool's input is read. `bash` parses `input.command`; `shell` takes
 * `input.command` from a shell the bash grammar cannot read (PowerShell) as one opaque
 * `interpreter` exec; `monitor` parses `input.command` as bash run in the background, or
 * reads `input.ws.url` as a net target; `path` reads the first string among `fields` as a
 * file path; `url` reads `input[field]` as a URL; `spawn` reads nothing (prompt and
 * description stay in `raw`); `kind` reads nothing and has a fixed kind (a web search, an
 * upload); `inert` has no side effect (bookkeeping): kind `other`, verb `inert`.
 */
export type ToolRule =
  | { reader: "bash" }
  | { reader: "shell" }
  | { reader: "monitor" }
  | { reader: "path"; fields: ReadonlyArray<string>; kind: CallKind; access: PathAccess }
  | { reader: "url"; field: string }
  | { reader: "spawn" }
  | { reader: "kind"; kind: CallKind }
  | { reader: "inert" };

const WRITE_RULE: ToolRule = {
  reader: "path",
  fields: ["file_path"],
  kind: "fs.write",
  access: "write",
};
const PATH_READ_RULE: ToolRule = {
  reader: "path",
  fields: ["path"],
  kind: "fs.read",
  access: "read",
};
const PI_WRITE_RULE: ToolRule = { ...WRITE_RULE, fields: ["path"] };
const SPAWN: ToolRule = { reader: "spawn" };
const NET: ToolRule = { reader: "kind", kind: "net" };
const INERT: ToolRule = { reader: "inert" };

function all(rule: ToolRule, tools: ReadonlyArray<string>): Record<string, ToolRule> {
  return Object.fromEntries(tools.map((t) => [t, rule]));
}

/**
 * Claude Code bookkeeping tools (tools-reference, v2.1.285): task lists, plan mode,
 * questions, tool search, worktrees, messages, skills, LSP. They change nothing jevdict
 * judges, so they are `inert` rather than `other` (which is scored like exec).
 */
const INERT_TOOLS = [
  ...["TaskCreate", "TaskGet", "TaskList", "TaskUpdate", "TodoWrite", "TaskOutput", "TaskStop"],
  ...["ToolSearch", "WaitForMcpServers", "ListAgents", "ListMcpResourcesTool"],
  ...["ReadMcpResourceTool", "AskUserQuestion", "EnterPlanMode", "ExitPlanMode"],
  ...["ScheduleWakeup", "ReportFindings", "SubagentHandback", "LSP", "SendMessage"],
  ...["EnterWorktree", "ExitWorktree", "Skill", "SendFeedback", "CronDelete", "CronList"],
];

/**
 * The single tool → input-field mapping, so adapters stay policy-free (D-054). Tools not
 * listed are `other` (raw = JSON of the input), except an unknown non-MCP tool whose
 * adapter kind is `exec` and whose input has a string `command`: that is parsed as bash.
 * Capitalized names are Claude Code's (tools-reference and hook input shapes at
 * v2.1.285; `Task` and `MultiEdit` kept for older versions); lower-case names are Pi's
 * built-ins (input schemas verified at Pi v0.87.1).
 */
export const TOOL_RULES: Readonly<Record<string, ToolRule>> = {
  Bash: { reader: "bash" },
  PowerShell: { reader: "shell" },
  Monitor: { reader: "monitor" },
  Edit: WRITE_RULE,
  Write: WRITE_RULE,
  MultiEdit: WRITE_RULE,
  NotebookEdit: { ...WRITE_RULE, fields: ["notebook_path", "file_path"] },
  Read: { reader: "path", fields: ["file_path"], kind: "fs.read", access: "read" },
  Glob: PATH_READ_RULE,
  Grep: PATH_READ_RULE,
  WebFetch: { reader: "url", field: "url" },
  ...all(SPAWN, ["Agent", "Task", "Workflow", "CronCreate"]),
  ...all(NET, ["WebSearch", "Artifact", "SendUserFile", "PushNotification", "RemoteTrigger"]),
  ShareOnboardingGuide: NET,
  ...all(INERT, INERT_TOOLS),
  bash: { reader: "bash" },
  powershell: { reader: "shell" },
  read: PATH_READ_RULE,
  write: PI_WRITE_RULE,
  edit: PI_WRITE_RULE,
  grep: PATH_READ_RULE,
  find: PATH_READ_RULE,
  ls: PATH_READ_RULE,
};

/**
 * Harness-specific tool names → the name the context engine's tables use (scope's
 * expected tools, the Bash/Write content rules). Names not listed are their own, apart
 * from MCP tools (see {@link canonicalTool}).
 */
export const TOOL_ALIASES: Readonly<Record<string, string>> = {
  Agent: "Task",
  MultiEdit: "Edit",
  NotebookEdit: "Edit",
  PowerShell: "Bash",
  Monitor: "Bash",
  bash: "Bash",
  powershell: "Bash",
  read: "Read",
  write: "Write",
  edit: "Edit",
  grep: "Grep",
  find: "Glob",
  ls: "Glob",
};

/** Claude Code's MCP tool name: `mcp__<server>__<tool>` (the server ends at the first `__`). */
const CLAUDE_MCP = /^mcp__(.+?)__(.+)$/s;
/** The spec's MCP tool name: `mcp:<server>:<tool>`. */
const SPEC_MCP = /^mcp:([^:]+):(.+)$/s;

/**
 * The canonical name of `tool`: {@link TOOL_ALIASES}, and Claude Code's
 * `mcp__<server>__<tool>` as the spec's `mcp:<server>:<tool>`. Unknown names map to
 * themselves.
 */
export function canonicalTool(tool: string): string {
  const mcp = CLAUDE_MCP.exec(tool);
  if (mcp !== null) return `mcp:${mcp[1]}:${mcp[2]}`;
  return lookup(TOOL_ALIASES, tool) ?? tool;
}

/** The MCP server of an MCP tool in either spelling; null for any other tool. */
export function mcpServer(tool: string): string | null {
  return SPEC_MCP.exec(canonicalTool(tool))?.[1] ?? null;
}

/** The rule `tool` is read with, by its exact name; undefined when it has none. */
export function toolRule(tool: string): ToolRule | undefined {
  return lookup(TOOL_RULES, tool);
}

/** True for a bookkeeping tool with no side effect (kind `other`, verb `inert`). */
export function isInertTool(tool: string): boolean {
  return toolRule(tool)?.reader === "inert";
}
