import type { CallKind, Harness } from "../schema/event.ts";
import { INTERACTIVE_SHELL_VERB } from "./interpreters.ts";
import { lookup } from "./options.ts";
import type { PathAccess } from "./types.ts";

/**
 * How one tool's input is read. `bash` parses `input.command` (in `input[workdir]` when
 * set: that call's working directory); `shell` takes `input[field]` (default `command`)
 * from a shell or interpreter the bash grammar cannot read (PowerShell, OpenCode's code
 * mode) as one opaque `interpreter` exec; `monitor` parses `input.command` as bash run in
 * the background, or reads `input.ws.url` as a net target; `path` reads the first string
 * among `fields` as a file path; `url` reads `input[field]` as a URL; `patch` reads
 * `input[field]` as an `apply_patch` patch (patch.ts); `spawn` reads nothing (prompt and
 * description stay in `raw`); `kind` reads nothing and has a fixed kind (a web search, an
 * upload) plus optional `verbs`; `inert` has no side effect (bookkeeping): kind `other`,
 * verb `inert`.
 */
export type ToolRule =
  | { reader: "bash"; workdir?: string }
  | { reader: "shell"; field?: string }
  | { reader: "monitor" }
  | { reader: "path"; fields: ReadonlyArray<string>; kind: CallKind; access: PathAccess }
  | { reader: "url"; field: string }
  | { reader: "patch"; field: string }
  | { reader: "spawn" }
  | { reader: "kind"; kind: CallKind; verbs?: ReadonlyArray<string> }
  | { reader: "inert" };

/** A harness's tool name → the rule its input is read with. */
export type ToolTable = Readonly<Record<string, ToolRule>>;

const BASH: ToolRule = { reader: "bash" };
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
const FILE_PATH_WRITE: ToolRule = { ...WRITE_RULE, fields: ["filePath"] };
const FILE_PATH_READ: ToolRule = { ...PATH_READ_RULE, fields: ["filePath"] };
const SPAWN: ToolRule = { reader: "spawn" };
const NET: ToolRule = { reader: "kind", kind: "net" };
const INERT: ToolRule = { reader: "inert" };

function all(rule: ToolRule, tools: ReadonlyArray<string>): Record<string, ToolRule> {
  return Object.fromEntries(tools.map((t) => [t, rule]));
}

/**
 * Claude Code bookkeeping tools (tools-reference, v2.1.285): task lists, plan mode,
 * questions, tool search, messages, skills, LSP. They change nothing jev-cops judges, so
 * they are `inert` rather than `other` (which is scored like exec). `EnterWorktree` and
 * `ExitWorktree` are deliberately absent: they create and remove git worktrees on disk,
 * so they stay `other` and fail closed when the judge is unreachable (D-081).
 */
const INERT_TOOLS = [
  ...["TaskCreate", "TaskGet", "TaskList", "TaskUpdate", "TodoWrite", "TaskOutput", "TaskStop"],
  ...["ToolSearch", "WaitForMcpServers", "ListAgents", "ListMcpResourcesTool"],
  ...["ReadMcpResourceTool", "AskUserQuestion", "EnterPlanMode", "ExitPlanMode"],
  ...["ScheduleWakeup", "ReportFindings", "SubagentHandback", "LSP", "SendMessage"],
  ...["Skill", "SendFeedback", "CronDelete", "CronList"],
];

/**
 * Claude Code (tools-reference and hook input shapes at v2.1.285; `Task` and `MultiEdit`
 * kept for older versions).
 */
const CLAUDE_CODE_TOOLS: ToolTable = {
  Bash: BASH,
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
};

/** Pi built-ins (input schemas verified at v0.87.1 and v0.99.1: `path`, not `filePath`). */
const PI_TOOLS: ToolTable = {
  bash: BASH,
  powershell: { reader: "shell" },
  read: PATH_READ_RULE,
  write: PI_WRITE_RULE,
  edit: PI_WRITE_RULE,
  grep: PATH_READ_RULE,
  find: PATH_READ_RULE,
  ls: PATH_READ_RULE,
};

/**
 * Codex at the hook boundary (`core/src/tools/hook_names.rs`; PLAN-M3 §2.1 rows 9–11):
 * shell tools and `exec_command` arrive as `Bash` with a string `command`
 * (`unified_exec/exec_command.rs:519-530`); `apply_patch` carries the raw patch in
 * `command` (`handlers/apply_patch.rs:290-296`); function tools send their arguments.
 * `write_stdin` runs no `PreToolUse` today (`write_stdin.rs:129-134`); should it ever,
 * it types into a running session: an exec with the interactive-shell verb. Hosted tools
 * (`WebSearch`) run no hook either; if they did they would be net with no host.
 * `request_plugin_install` and `request_permissions` are absent on purpose: they widen
 * what the session may do, so they stay `other` (scored like exec, fail closed).
 */
const CODEX_TOOLS: ToolTable = {
  Bash: BASH,
  apply_patch: { reader: "patch", field: "command" },
  view_image: PATH_READ_RULE,
  write_stdin: { reader: "kind", kind: "exec", verbs: [INTERACTIVE_SHELL_VERB] },
  ...all(SPAWN, ["spawn_agent", "followup_task", "send_input", "send_message", "resume_agent"]),
  ...all(NET, ["WebSearch", "web_search"]),
  ...all(INERT, ["update_plan", "request_user_input", "get_context_remaining", "current_time"]),
  ...all(INERT, ["sleep", "tool_search", "new_context_window", "wait_agent", "list_agents"]),
  ...all(INERT, ["close_agent", "interrupt_agent"]),
};

/**
 * OpenCode built-ins (`packages/opencode/src/tool/*.ts` at `dev`, 1.18.33; PLAN-M3 §2.2
 * row 11): file tools read `filePath`; `bash` runs in `workdir` when given
 * (`tool/shell.ts:612-614`); `execute` is code mode's model-written script. `skill` is
 * absent on purpose (it loads instruction text: `other`, scored like exec); MCP tools are
 * `<server>_<tool>`, indistinguishable from custom tools, so `other` as well.
 */
const OPENCODE_TOOLS: ToolTable = {
  bash: { reader: "bash", workdir: "workdir" },
  edit: FILE_PATH_WRITE,
  write: FILE_PATH_WRITE,
  read: FILE_PATH_READ,
  lsp: FILE_PATH_READ,
  glob: PATH_READ_RULE,
  grep: PATH_READ_RULE,
  task: SPAWN,
  webfetch: { reader: "url", field: "url" },
  websearch: NET,
  apply_patch: { reader: "patch", field: "patchText" },
  execute: { reader: "shell", field: "code" },
  ...all(INERT, ["todowrite", "question", "plan_exit"]),
};

/**
 * The M1 table: Claude Code's capitalized names and Pi's lower-case built-ins, which never
 * collide. Both M1 harnesses keep reading with it, unchanged, and so does a caller that
 * names no harness.
 */
export const TOOL_RULES: ToolTable = { ...CLAUDE_CODE_TOOLS, ...PI_TOOLS };

/**
 * The tool table of each harness, so adapters stay policy-free (D-054). OpenCode shares
 * `bash`, `read`, `write`, `edit` and `grep` with Pi but reads other fields (`filePath`
 * against `path`), so Codex and OpenCode names are read only on their own harness, and
 * theirs never on Claude Code or Pi. Tools not listed are `other` (raw = JSON of the
 * input), except an unknown non-MCP tool whose adapter kind is `exec` and whose input has
 * a string `command`: that is parsed as bash.
 */
export const HARNESS_TOOL_RULES: Readonly<Record<Harness, ToolTable>> = {
  "claude-code": TOOL_RULES,
  codex: CODEX_TOOLS,
  opencode: OPENCODE_TOOLS,
  pi: TOOL_RULES,
};

/** The M1 aliases (Claude Code's and Pi's names), as {@link TOOL_RULES}. */
export const TOOL_ALIASES: Readonly<Record<string, string>> = {
  ...{ Agent: "Task", MultiEdit: "Edit", NotebookEdit: "Edit", PowerShell: "Bash" },
  ...{ Monitor: "Bash", bash: "Bash", powershell: "Bash", read: "Read", write: "Write" },
  ...{ edit: "Edit", grep: "Grep", find: "Glob", ls: "Glob" },
};

/**
 * Harness-specific tool names → the name the context engine's tables use (scope's
 * expected tools, the Bash/Write content rules). Names not listed are their own, apart
 * from MCP tools (see {@link canonicalTool}).
 */
export const HARNESS_TOOL_ALIASES: Readonly<Record<Harness, Readonly<Record<string, string>>>> = {
  "claude-code": TOOL_ALIASES,
  codex: { apply_patch: "Edit", spawn_agent: "Task", view_image: "Read" },
  opencode: {
    ...{ bash: "Bash", read: "Read", write: "Write", edit: "Edit", grep: "Grep", glob: "Glob" },
    ...{ task: "Task", apply_patch: "Edit", webfetch: "WebFetch", websearch: "WebSearch" },
    execute: "Bash",
  },
  pi: TOOL_ALIASES,
};

/** Claude Code's MCP tool name: `mcp__<server>__<tool>` (the server ends at the first `__`). */
const CLAUDE_MCP = /^mcp__(.+?)__(.+)$/s;
/** The spec's MCP tool name: `mcp:<server>:<tool>`. */
const SPEC_MCP = /^mcp:([^:]+):(.+)$/s;

/**
 * The canonical name of `tool` on `harness`: its alias, and `mcp__<server>__<tool>`
 * (Claude Code, Codex, Pi 0.99) as the spec's `mcp:<server>:<tool>`. Unknown names map
 * to themselves. Without a harness the M1 aliases apply ({@link TOOL_ALIASES}).
 */
export function canonicalTool(tool: string, harness?: Harness): string {
  const mcp = CLAUDE_MCP.exec(tool);
  if (mcp !== null) return `mcp:${mcp[1]}:${mcp[2]}`;
  const aliases = harness === undefined ? TOOL_ALIASES : lookup(HARNESS_TOOL_ALIASES, harness);
  return (aliases === undefined ? undefined : lookup(aliases, tool)) ?? tool;
}

/** The MCP server of an MCP tool in either spelling; null for any other tool. */
export function mcpServer(tool: string): string | null {
  return SPEC_MCP.exec(canonicalTool(tool))?.[1] ?? null;
}

/**
 * The rule `tool` is read with on `harness`, by its exact name; undefined when it has
 * none (and for an unknown harness). Without a harness: the M1 table ({@link TOOL_RULES}).
 */
export function toolRule(tool: string, harness?: Harness): ToolRule | undefined {
  const table = harness === undefined ? TOOL_RULES : lookup(HARNESS_TOOL_RULES, harness);
  return table === undefined ? undefined : lookup(table, tool);
}

/** True for a bookkeeping tool with no side effect (kind `other`, verb `inert`) on `harness`. */
export function isInertTool(tool: string, harness?: Harness): boolean {
  return toolRule(tool, harness)?.reader === "inert";
}
