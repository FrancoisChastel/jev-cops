# Codex hook payloads

The documented stdin payloads of a Codex command hook, built from the generated schemas
(`codex-rs/hooks/schema/generated/pre-tool-use.command.input.json` and
`post-tool-use.command.input.json`, `openai/codex@main` on 2026-09-30) and the handlers
that fill `tool_name`/`tool_input` (PLAN-M3 §2.1 rows 9–12). Every file carries the
required fields: `session_id`, `turn_id`, `transcript_path`, `cwd`, `hook_event_name`,
`model`, `permission_mode`, `tool_name`, `tool_input`, `tool_use_id` (plus
`tool_response` on `PostToolUse`); `agent_id`/`agent_type` only on a subagent's call.

What the sources say about `tool_input`:

- Shell commands and unified exec (`exec_command`) are `Bash` with `{ "command": <string> }`
  (`core/src/tools/handlers/unified_exec/exec_command.rs:519-530`). The model-facing
  `workdir`, `tty`, `shell` and `login` arguments are **not** in the payload.
- `apply_patch` is `{ "command": <the raw patch text> }` (`handlers/apply_patch.rs:290-296`,
  `415-420`). A shell command `apply_patch <<'EOF' … EOF` is a `Bash` call that Codex then
  intercepts and applies as a patch (`exec_command.rs:377-388`).
- `write_stdin` never runs `PreToolUse` (`handlers/unified_exec/write_stdin.rs:129-134`).
- MCP tools are `mcp__<server>__<tool>` with their JSON arguments; other local function
  tools (`spawn_agent`, `view_image`, `update_plan`, …) send their arguments as is.
- Hosted tools such as `WebSearch` do not run hooks (`hooks.md`, "Tool coverage").

`tool_response` for `Bash` is not specified by the docs; `post-tool-use.bash.json` holds a
placeholder string until the live capture (PLAN-M3 §6.3) replaces these files with
captured payloads (paths rewritten to `/home/dev` and `/work/repo`).
