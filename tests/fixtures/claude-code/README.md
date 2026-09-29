# Claude Code hook payloads

The documented stdin payloads of a Claude Code command hook (code.claude.com/docs/en/hooks,
v2.1.285): one file per event, copied from the hooks reference examples, plus a subagent
`PreToolUse` (`agent_id`, `agent_type`), an MCP tool call (`mcp_server`), and a Windows
`Write` path kept as a negative case (jevdict does not normalize backslash paths in M1).
`pre-tool-use.bash.json` is the payload a real `claude` 2.1.280 sent in a captured run
(same fields, apart from the ids and paths).
