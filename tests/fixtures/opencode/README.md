# OpenCode plugin hook payloads

`tool-execute-before.json` holds one `tool.execute.before` call per built-in tool, shaped as
the plugin receives it: `input: { tool, sessionID, callID }` and `output: { args }`
(`packages/plugin/src/index.ts` `Hooks`, `anomalyco/opencode@dev` on 2026-09-30), with the
plugin's `directory` (`PluginInput`) as the working directory. The `args` follow each tool's
parameter schema:

| Tool | Arguments (source) |
|---|---|
| `bash` | `command`, `timeout?` (ms), `workdir?` (`tool/shell/prompt.ts:16-23`; the id stays `bash` for every shell kind, `tool/shell/id.ts`) |
| `edit` | `filePath`, `oldString`, `newString`, `replaceAll?` (`tool/edit.ts:47-56`) |
| `write` | `content`, `filePath` (`tool/write.ts:20-25`) |
| `read` | `filePath`, `offset?`, `limit?` (`tool/read.ts:28-36`) |
| `glob` / `grep` | `pattern`, `path?` (+ `include?` for grep) (`tool/glob.ts:10-15`, `tool/grep.ts:10-18`) |
| `lsp` | `operation`, `filePath`, `line`, `character`, `query?` (`tool/lsp.ts:23-35`) |
| `task` | `description`, `prompt`, `subagent_type`, `task_id?`, `command?`, `background?` (`tool/task.ts:44-60`) |
| `webfetch` | `url`, `format`, `timeout?` (`tool/webfetch.ts:13-22`) |
| `websearch` | `query`, … (`tool/websearch.ts:10-25`) |
| `apply_patch` | `patchText` (`tool/apply_patch.ts:18-20`) |
| `skill` | `name` (`tool/skill.ts:8-10`) |
| `todowrite` / `question` / `plan_exit` | `todos` / `questions` / nothing (`tool/todo.ts`, `tool/question.ts`, `tool/plan.ts`) |
| `execute` | `code` (code mode, `tool/code-mode.ts:16-20`) |
| MCP | `<server>_<tool>` (`mcp/catalog.ts` `toolName`), the tool's own arguments |

The same names as Pi's built-ins (`bash`, `read`, `write`, `edit`, `grep`) carry other field
names (`filePath` against Pi's `path`), which is why core reads tools by harness. These are
documented shapes; the live capture (PLAN-M3 §6.3) replaces them with captured calls.
