# M3 plan — Codex and OpenCode adapters, Pi parity, replay gate

Source of truth: [SPEC.md](./SPEC.md). M3 definition of done (spec §Milestones): "Codex
`hooks.json` writer and execpolicy fragment, OpenCode plugin with the subagent and Desktop gaps
printed by `doctor`, `jevdict replay` over at least 20 recorded sessions with the delta reviewed."
The owner's ask (2026-09-30, "plan to add support to open code, codex and pi") widens it: all
three are first-class like Claude Code — `cops install`, `cops doctor`, fail closed, verified
live against a proven-offline fake model API.

Docs re-read on 2026-09-30 (ground rule: docs win over the spec; every difference is listed).
Raw fetches are under `/private/tmp/claude-501/m3-plan/{codex,opencode,pi,skillspector}/`.
Installed here: `codex-cli 0.153.4` (latest release `rust-v0.159.2`, 2026-09-29),
`opencode 1.18.33` (latest, 2026-09-28), `pi 0.83.0` (latest `v0.99.1`, 2026-09-29).
Sources: Codex — `developers.openai.com/codex/{hooks,rules,config-reference,noninteractive,
multi-agent,sandbox}.md`, `learn.chatgpt.com/docs/enterprise/managed-configuration.md`, and
`openai/codex@main`: `codex-rs/hooks/src/{events/pre_tool_use.rs,engine/command_runner.rs,
engine/dispatcher.rs,schema/generated/*.json}`, `codex-rs/core/src/{hook_runtime.rs,
tools/hook_names.rs,tools/handlers/shell_spec.rs,tools/handlers/multi_agents_spec.rs}`,
`codex-rs/config/src/hook_config.rs`, `codex-rs/apply-patch/src/parser.rs`, PR #20527, issue
#20692, releases. OpenCode — `opencode.ai/docs/{plugins,config,permissions,cli,providers}` (the
`.mdx` sources) and `anomalyco/opencode@dev` (`sst/opencode` redirects there): `packages/plugin/
src/index.ts`, `packages/opencode/src/{plugin/index.ts,config/plugin.ts,config/paths.ts,
session/tools.ts,session/prompt.ts,permission/index.ts,tool/*.ts,tool/shell/id.ts,
mcp/catalog.ts}`, `packages/core/src/{flag/flag.ts,global.ts}`, `packages/sdk/js/src/gen/
{types,sdk}.gen.ts`, issues #5894, #38604, #27900. Pi — `earendil-works/pi` at `v0.87.1` and
`v0.99.1`: `packages/coding-agent/{CHANGELOG.md,docs/extensions.md,src/core/extensions/
types.ts,src/core/agent-session.ts,src/modes/print-mode.ts}`. SkillSpector —
`NVIDIA/SkillSpector` `docs/{PI_EXTENSION,OPENCODE_EXTENSION}.md`. Quotes are verbatim.

Concurrent work this plan sequences around (file ownership in §6): M2 (`packages/openshell`,
`packages/daemon/src/audit*`, daemon OpenShell wiring and JIT grants, the hook's `--url`);
the setup/scanner track (`cops setup`, service install, scanners incl. SkillSpector, a
`skill-install` policy — `docs/PLAN-SETUP.md` does not exist yet); npm packaging (`jev-cops`
meta package, `@jev-cops/*` manifests); the `config-tamper` fix (ancestor deletes, judge-CLI
matching) in `policies/config-tamper.ts` and `policies/_lib/config-findings.ts`.

## 1. Definition of done and gate

| Item | Planned as |
|---|---|
| Codex `hooks.json` writer | `cops install codex [--user\|--project\|--managed]`: exec-form-free (Codex has none) shell-string command hooks for `PreToolUse`, `PostToolUse`, `UserPromptSubmit`, `SessionStart`, `SessionEnd` in `$CODEX_HOME/hooks.json`, merged, backed up, idempotent, `--uninstall`, `--dry-run`; prints the mandatory trust step (§3.1); `--managed` writes or prints a `/etc/codex/requirements.toml` fragment (trusted by policy) |
| Codex execpolicy fragment | `$CODEX_HOME/rules/jev-cops.rules` (Starlark `prefix_rule`s): `forbidden` for the context-free deny class (stopping the judge, running its admin CLI, running the hook), `prompt` for nested harness CLIs and hook-skipping flags; validated with `codex execpolicy check`; the context-dependent deny class (taint, default branch) has no static prefix and is recorded as absent, like OpenShell's (D-106) |
| Codex hook | the same `dist/cops-hook` binary with `--harness codex` (spec: "reuse the Claude Code hook binary; only the config writer differs"): the contract matches for exit 2, JSON deny, `additionalContext`, `UserPromptSubmit` block and the input fields; the four differences (§2.1 rows 4–7) live in a Codex output mapper |
| OpenCode plugin | one self-contained file `adapters/opencode/jev-cops.ts` (Node built-ins only, like Pi): `tool.execute.before` judges, throws to block, mutates `output.args` keys in place to rewrite; `tool.execute.after` observes; `chat.message` pins the task; `event` links subagent sessions and observes failed calls; `cops install opencode`, `cops doctor` prints the subagent, Desktop and every other gap |
| Pi parity | §4: `/v1/session` reports, killed-session abort at the next prompt, session end, install-time version record, doctor canary through the installed file, `parentToolCallId`/`mcp__` names from 0.99 |
| Replay over ≥ 20 sessions | `tests/replay/` holds ≥ 22 recorded root sessions (fake runners for all four harnesses against a real `copsd`, paths rewritten to the fixture home) plus the redacted audits of the three live captures; `bun run replay:gate` runs `cops replay` over all of them and fails on any delta not listed in `tests/replay/ACCEPTED.md`; the M3 deltas (apply_patch paths, OpenCode names, the interactive-shell hold) are reviewed there |

**Gate:** `bun test tests/tamper` with these rows live on the new harnesses: T1 (Codex hook: an
`apply_patch` that adds `~/.codex/hooks.json` and a `Bash` write to it are `kill`, the session is
latched and the next `UserPromptSubmit` is blocked; OpenCode plugin: a `write` of
`~/.config/opencode/opencode.json` throws and the session is aborted and latched), T2 (Codex:
exec/patch/MCP fail closed, `view_image` and inert tools proceed with a warning; OpenCode:
`bash`/`edit`/`write`/`webfetch`/`task` throw when copsd is down, `read`/`glob`/`grep`/`lsp`
proceed with a log line), T3 (both: "judge timeout" in under 14 s while the harness would have
waited 30 s / forever), T4 (installers: Codex refuses `[features] hooks = false` and
`allow_managed_hooks_only` for a user install, prints the trust step and the `write_stdin`,
hosted-tool and bypass-flag gaps; OpenCode prints the Desktop, `after`-success-only, subagent,
`--pure` and plugin-order gaps; doctor prints every `CODEX_GAPS`/`OPENCODE_GAPS` line; the
OpenShell half stays M2's todo), T8 (no confirm exists on either: a hold is a deny whose
agent-visible reason is the verdict reason only, never the raw command or the summary), T9
(Codex: `permissionDecision: "allow"` + `updatedInput.command` ran the pinned command; OpenCode:
the pinned keys replaced the model's in `output.args`), T11 (both: the first prompt pins the
task; a subagent prompt never does). Plus `bun run gate` (policies), `bun run replay:gate`, and
three captured live runs (`docs/captures/{codex,opencode,pi}-m3.md`) against a local fake
Responses API with no real credentials (§6.3).

## 2. Docs-vs-spec tables

### 2.1 Codex (spec §Harness adapters table row and "Codex adapter"; docs = `hooks.md` and the `main` source on 2026-09-30, local CLI 0.153.4)

| # | Fact | Spec says | Docs say today (source, quote) | Consequence |
|---|---|---|---|---|
| 1 | Trust | "one-time trust of project hooks and skips them silently until then" | hooks.md: "Before a non-managed hook can run, Codex requires you to review and trust the exact hook definition. Codex records trust against the hook's current hash, so new or changed hooks are marked for review and skipped until trusted." "Use `/hooks` in the CLI to inspect hook sources, review new or changed hooks, trust hooks"; "Managed hooks from system, MDM, cloud, or `requirements.toml` sources are marked as managed, trusted by policy"; CLI flag `--dangerously-bypass-hook-trust`. | Trust is per handler hash and applies to **user** hooks too, not only project ones. `cops install codex` cannot activate the hook by itself: it prints the `/hooks` step; doctor reads `[hooks.state."file:<hooks.json>:pre_tool_use:0:0"].trusted_hash` in `config.toml` (key format from `codex-rs/hooks/src/config_rules.rs` tests) and its canary proves firing. Re-trust is needed after any change to the handler (socket, binary path). A managed install (`requirements.toml`) needs no trust. |
| 2 | Locations | "`~/.codex/hooks.json`, Claude-style" | "`hooks.json`" or "inline `[hooks]` tables inside `config.toml`" next to each active config layer; "`<repo>/.codex/hooks.json`"; "Project-local hooks load only when the project `.codex/` layer is trusted"; "If more than one hook source exists, Codex loads all matching hooks." | Writer targets `$CODEX_HOME/hooks.json` (user, default), `<repo>/.codex/hooks.json` (project, needs `projects."<path>".trust_level = "trusted"`), or the managed fragment. Inline `[hooks]` in `config.toml` is read for refusals and doctor, never written. |
| 3 | Handler form | — | Config shape: `{ "type": "command", "command": "python3 …", "timeout": 3 }`; "`timeout` is in seconds"; default "600 seconds for most hooks"; `SessionEnd` and `Interrupt` "use `1` second by default and support up to `3` seconds"; `command_runner.rs` spawns `$SHELL -lc "<command>"` (`default_shell_program`, fallback `/bin/sh`). | No exec form: the command is one shell string, so paths are single-quoted and refused when they contain `'`, NUL or a newline. The hook's parent is a login shell under `codex`: mode detection unwraps it (D-086 already unwraps up to three shells). A shell profile that prints on stdout would corrupt JSON: the offline canary runs the entry through `$SHELL -lc` exactly as Codex does. Timeouts written: PreToolUse 30, PostToolUse 15, UserPromptSubmit 10, SessionStart 10, SessionEnd 3. |
| 4 | Exit codes and failures | "same `permissionDecision` contract" | `pre_tool_use.rs`: exit `0` parses JSON (a JSON body that is not valid pre-tool-use output → `Failed`); exit `2` with non-empty stderr → `Blocked` ("blocking reason" = stderr), exit 2 with empty stderr → `Failed` ("did not write a blocking reason to stderr"); any other exit code or no status → `Failed`; `command_runner.rs`: a timeout is `outcome: "timeout"` with an error → `Failed`. `dispatcher.rs`: only `Blocked` sets `should_block`. hooks.md: a `PreToolUse` hook that returns an unsupported field "marks that hook run as failed, reports the error, and continues the tool call." | Every failure fails **open**, exactly like Claude Code: the hook keeps exit code 2 from its first line, its own 13 s deadline, and always writes the reason to stderr (at exit 2 Codex ignores stdout). Any stdout JSON must contain only supported fields: `systemMessage`, `hookSpecificOutput.{hookEventName, permissionDecision, permissionDecisionReason, updatedInput, additionalContext}`. |
| 5 | `ask` | "`PreToolUse`, `PermissionRequest`" | "`permissionDecision: "ask"`, legacy `decision: "approve"`, `continue: false`, `stopReason`, and `suppressOutput` are parsed but not supported yet. Codex marks the hook run as failed, reports the error, and continues the tool call." `PermissionRequest` "doesn't run for commands that don't need approval" and can only `allow`/`deny` a prompt Codex was about to show. | No hook can make Codex ask. `hold` → `deny` (D-008: "hold on harnesses with no ask maps to deny"), with the reason "held by jev-cops: <reason>; a human can approve with `cops grant <event-id>` and retry" (the M2 admin route; a plain deny until it lands). `PermissionRequest` is not registered (it cannot tighten anything PreToolUse did not already see). |
| 6 | Kill | "Deny plus session terminated" | `continue: false` unsupported on PreToolUse (row 5); supported on `PostToolUse`, `UserPromptSubmit` ("`decision: "block"` … You can also use exit code `2`"), `Stop`. | `kill` = exit 2 + stderr + JSON deny (never `continue`/`stopReason`); the daemon latches (D-076) so every later call is `kill` and the `UserPromptSubmit` hook blocks the next prompt with `decision: "block"`. The current turn runs on until the model stops: printed gap. |
| 7 | Rewrite | "`updatedInput` … since May 2026" | PR #20527 "Support PreToolUse updatedInput rewrites" merged 2026-05-12; "To rewrite a supported tool call without blocking, return `permissionDecision: "allow"` with `updatedInput`"; "For Bash commands and `apply_patch`, `updatedInput` must include a string `command` field"; "Return `updatedInput` only with `permissionDecision: "allow"`; other `updatedInput` shapes are reported as errors." `hook_runtime.rs`: a non-blocking outcome is `PreToolUseHookResult::Continue { updated_input }`, the tool then goes through its normal approval and sandbox path. | `rewrite` = `permissionDecision: "allow"` + `updatedInput` (the one place jev-cops writes `allow`): here `allow` means "not blocked", not "skip approval" (verified live in §6.3: a rewritten command that needs escalation still prompts). A rewrite whose payload lacks a string `command`, or aimed at anything but `Bash`, is mapped to deny ("rewrite unsupported on this tool"). |
| 8 | `additionalContext` | "`additionalContext` since May 2026" | Issue #20692 closed 2026-05-05 ("merging as we got #21069 in"); hooks.md: "To add model-visible context without blocking, return `hookSpecificOutput.additionalContext`"; `additionalContextLimit` default "2,500 tokens", oversized text is spilled to `<temp_dir>/hook_outputs/<session_id>/<uuid>.txt`. | `annotate` → `additionalContext` (`jev-cops: <note>`), same as Claude Code; notes are short by construction. |
| 9 | `unified_exec` | "does not yet route every shell call through hooks (`unified_exec`)" | Tool coverage: "Unified exec (`exec_command`) \| Yes \| Yes \| Match as `Bash`"; "`write_stdin` is transport for an existing unified-exec session. It doesn't run `PreToolUse` again when it sends input or polls a command that already passed `PreToolUse`"; "Some specialized tool paths can opt out of the default hook path. Treat tool hooks as a useful guardrail, not a complete enforcement boundary."; config-reference: `features.unified_exec` "stable; enabled by default except on Windows". | The gap moved: `exec_command` is judged, **stdin written into a running session is not**. Core (§5) gives a bare interactive shell or REPL (`bash`, `sh`, `python`, `node` with no script) the `interactive-shell` verb and `opaque-exec` holds it, so a session that would accept unseen commands needs a human (a deny on Codex). Hosted tools ("such as `WebSearch`") are unhooked. Both printed; the execpolicy fragment cannot see stdin either; OpenShell is the floor. |
| 10 | Tool names and input | Codex "array `command`"; "no separate Read tool; reads via `cat`, `head`, `sed -n`" | `tool_name` "such as `Bash`, `apply_patch`, or an MCP name like `mcp__fs__read`"; `hook_names.rs`: shell-like tools serialize as `Bash`, `apply_patch` (aliases `Write`/`Edit` for matchers only), `spawn_agent` (alias `Agent`); "`Bash` and `apply_patch` use `tool_input.command`" (`pre_tool_use.rs`: "Shell-like tools pass `{ "command": ... }` as `tool_input`"); MCP and other local function tools "send their arguments"; `shell_spec.rs`: the model-facing `exec_command` takes `cmd`, `workdir`, `tty`, `shell`, `login`, `yield_time_ms`, but the hook sees `command`. No read tool; `view_image` takes a `path`. | At the hook boundary Codex's shell input is a **string** under `command`, identical to Claude Code's `Bash`: core's existing `Bash` rule applies unchanged. New core rules: `apply_patch` (patch grammar → write/delete/move paths), `spawn_agent` and the other `multi_agents_spec.rs` tools (`send_input`, `send_message`, `followup_task`, `resume_agent`, `wait_agent`, `list_agents`, `close_agent`, `interrupt_agent`), `view_image` (read), `update_plan`, `request_user_input`, `get_context_remaining`, `current_time`, `sleep`, `tool_search`, `new_context_window` (inert); `request_plugin_install` and `request_permissions` stay `other` (scored like exec). MCP names are already `mcp__s__t` → `mcp:s:t`. |
| 11 | `apply_patch` | "file edits performed through `apply_patch`" | `apply-patch/src/parser.rs` grammar: `*** Begin Patch`, `*** Add File: <path>`, `*** Delete File: <path>`, `*** Update File: <path>` optionally followed by `*** Move to: <path>`, `*** End of File`, `*** End Patch`; `apply_patch_spec.rs` adds an optional `*** Environment ID:` line. | Core `patch` reader (§5): Add/Update → write, Delete → delete, Move → write of the target plus delete of the source; relative paths resolve against `cwd`; content taint from added `+` lines. Same reader serves OpenCode's `apply_patch` (`patchText`). |
| 12 | Input fields | "`PreToolUse`, `PermissionRequest` … `PostToolUse`" | Generated schema `pre-tool-use.command.input.json` requires `cwd`, `hook_event_name`, `model`, `permission_mode` (`default`, `acceptEdits`, `plan`, `dontAsk`, `bypassPermissions`), `session_id`, `tool_input`, `tool_name`, `tool_use_id`, `transcript_path`, `turn_id`; optional `agent_id`, `agent_type`. hooks.md: "`session_id` … Subagent hooks use the parent session id." `hook_runtime.rs` `hook_permission_mode`: `Never` → `bypassPermissions`, everything else → `default`. | The Claude Code payload parser accepts it as is (unknown keys dropped, D-085); `model` fills `actor.model`; `agent_id` → `sess_<sid>.<agent_id>` with `actor.kind: "subagent"` (D-070/D-075). `bypassPermissions` reaches the daemon's no-human flag (D-078) whenever `-a never` is set (every `codex exec` in CI). |
| 13 | Events and matchers | "`PreToolUse`, `PermissionRequest` … `PostToolUse`" | Events: `SessionStart` (`source`: `startup`, `resume`, `clear`, `compact`, `fork`), `SessionEnd` (main thread only; "after a conversation has been idle and isn't open in any connected client for 30 minutes"), `SubagentStart`/`SubagentStop`, `PreToolUse`, `PermissionRequest`, `PostToolUse` ("For Bash, it also runs after commands that exit with a non-zero status"), `PreCompact`, `PostCompact`, `UserPromptSubmit`, `Stop`, `Interrupt`. "Use `"*"`, `""`, or omit `matcher` entirely to match every occurrence." "Multiple matching command hooks for the same event are launched concurrently"; "Matching hooks from multiple files all run." | Registered: `PreToolUse`, `PostToolUse` (success and failure in one event: `ok` from the response), `UserPromptSubmit`, `SessionStart`, `SessionEnd` (best effort, 3 s cap), all without matcher. `SubagentStart` is not registered (nothing to send; the per-event `agent_id` links). Another file's hook cannot undo a block (`should_block |=`). |
| 14 | Disabling | — | "Hooks are enabled by default. To turn them off … `[features] hooks = false`" (`codex_hooks` deprecated alias); `allow_managed_hooks_only = true` "skips hooks from user, project, session, and plugin sources"; CLI `--enable`/`--disable <FEATURE>` ("Equivalent to `-c features.<name>=true`"), `-c key=value`, `--profile`, `codex exec --ignore-user-config` ("doesn't load `$CODEX_HOME/config.toml`"), `--ignore-rules` ("skip user and project execpolicy `.rules` files"); `projects."<path>".trust_level = "untrusted"` "skip[s] project-scoped `.codex/` layers, including project-local config, hooks, and rules". | Installer refusals and doctor checks (§3.1); core's `HARNESS_CLIS` `codex` entry gains these flags as `harness-config` (D-072 said "re-verify in M3"). `--ignore-user-config` is printed as unverified for `hooks.json` (it names `config.toml` only). |
| 15 | Managed | — | managed-configuration.md: "System `requirements.toml` (`/etc/codex/requirements.toml` on Unix systems, including Linux and macOS, or `%ProgramData%\OpenAI\Codex\requirements.toml` on Windows)"; hooks.md: `[hooks] managed_dir = "/enterprise/hooks"`, "Managed hook commands should use absolute script paths under the configured managed directory", "To enforce managed hooks even for users who disabled hooks locally, pin `[features].hooks = true`". Legacy `managed_config.toml` is a defaults layer. | `--managed` (root only, never sudo, D-089 parity) writes or prints a fragment with `managed_dir` = the directory of `cops-hook` (`/usr/local/libexec/jev-cops` in the M2 image) and `[features] hooks = true`; no trust step. `/etc/codex` and the Windows path join `config-tamper` (kill). |
| 16 | Execpolicy | "`.codex/rules` execpolicy prefix rules generated by the OpenShell compiler for the deny class" | rules.md: "Rules are experimental and may change."; `prefix_rule(pattern, decision, justification, match, not_match)`; "Each element is either: A literal string … A union of literals"; "Codex applies the most restrictive decision when more than one rule matches (`forbidden` > `prompt` > `allow`)"; `forbidden`: "Block the request without prompting"; linear `bash -lc` chains "made only of plain words … joined by safe operators" are split with tree-sitter, anything with redirection, substitution, variables, wildcards or control flow "is treated as … a single invocation"; `codex execpolicy check --rules … -- <cmd>`; "When you add a command to the allow list in the TUI, Codex writes to the user layer at `~/.codex/rules/default.rules`". | The emitter is jev-cops's (`adapters/codex/src/rules.ts`, not the OpenShell compiler): prefix rules can express only argv prefixes, so the fragment carries the judge-guard class (§3.1) and `prompt` for nested harness CLIs; path-based kills (`rm ~/.codex/hooks.json`, redirections) cannot be expressed and stay with the hook and OpenShell. Whether `forbidden` also applies to commands that would run *inside* the sandbox is not stated ("control which commands Codex can run outside the sandbox"): verified live (§6.3), printed until then. `~/.codex/rules` is already kill-tier (D-073). |
| 17 | Sandbox and approvals | "sandbox modes/approval policies and headless `codex exec`" | sandbox docs: `sandbox_mode` `read-only`/`workspace-write`/`danger-full-access`; `approval_policy` `on-request`/`never`/granular ("`untrusted` is unsupported, and `on-failure` is deprecated"); `--dangerously-bypass-approvals-and-sandbox` (alias `--yolo`); in `workspace-write`, "`<writable_root>/.codex` is protected as read-only when it exists as a directory" (also `.git`, `.agents`); noninteractive.md: `codex exec --json` "stdout becomes a JSON Lines (JSONL) stream", `--skip-git-repo-check`, `--full-auto` deprecated. | Codex's own sandbox already makes a project `.codex/` read-only for the model (the one config file the kernel protects for Claude Code was the opposite case). Mode: `headless` when the parent argv (through the login shell) is `codex exec|e|review|exec-server|app-server|mcp-server`; an unreadable parent counts as headless (D-086). |
| 18 | Post payload | "`PostToolUse`" | `tool_response`: "MCP tools send the MCP call result. Other local function tools normally send their model-facing output." Not specified further for `Bash`. | The mapper is lenient like D-080: a string is the text; an object is read for `stdout`/`stderr`/`output`/`aggregated_output`/`exit_code`/`content[]`; else canonical JSON. The exact shape for `Bash` and `apply_patch` is confirmed by the live capture and frozen into `tests/fixtures/codex/`. |
| 19 | Subagents | — | multi-agent.md: "Current Codex releases enable subagent workflows by default"; `multi_agents_spec.rs` tool names (row 10); `SubagentStart` input `agent_id`, `agent_type`; PreToolUse optional `agent_id`/`agent_type`. | `spawn_agent` is `spawn` with its prompt as the future `subagent-spawn` text; a subagent's calls are judged under `sess_<sid>.<agent_id>` (verified live, row 12). |
| 20 | Config change | "ConfigChange" (Claude Code only) | No `ConfigChange` event exists; whether Codex re-reads `hooks.json` mid-session is not stated. | No intact check; `config-tamper` kills writes to `config.toml`, `hooks.json`, `rules/` (D-073); doctor re-verifies the file; printed gap. |

Releases since the spec (2026-09-29): `rust-v0.159.0` … `0.161.0-alpha.4`; none of the last eight release notes mentions hooks, execpolicy or `write_stdin`. Docs verified at `main` 2026-09-30; the local 0.153.4 is six minor versions behind: doctor warns on drift below the verified version and the live capture runs the installed binary.

### 2.2 OpenCode (spec row and "OpenCode adapter"; docs = `opencode.ai/docs` sources and `anomalyco/opencode@dev` on 2026-09-30, v1.18.33)

| # | Fact | Spec says | Docs say today (source, quote) | Consequence |
|---|---|---|---|---|
| 1 | Repository | `github.com/anomalyco/opencode` | `api.github.com/repos/sst/opencode` redirects to `anomalyco/opencode`, default branch `dev`. | Sources and issues are read there. |
| 2 | Locations | "`.opencode/plugin/` or `~/.config/opencode/plugin/`" | plugins.mdx: "`.opencode/plugins/` - Project-level plugins", "`~/.config/opencode/plugins/` - Global plugins"; config.mdx: "plural names … Singular names (e.g., `agent/`) are also supported for backwards compatibility"; `config/plugin.ts`: `Glob.scan("{plugin,plugins}/*.{ts,js}")` under every config directory; `config/paths.ts` directories: `Global.Path.config` (`$XDG_CONFIG_HOME/opencode`), each `.opencode` from the cwd up to the worktree, `~/.opencode`, `$OPENCODE_CONFIG_DIR`. Load order: "Global config … Project config … Global plugin directory … Project plugin directory". npm plugins via `"plugin": [...]`, installed "using Bun at startup" into `~/.cache/opencode/node_modules/`. | Installer writes `<config dir>/plugins/jev-cops.ts` (global default: `$OPENCODE_CONFIG_DIR` else `~/.config/opencode`) or `<project>/.opencode/plugins/jev-cops.ts`. **Every file in `plugin(s)/` is loaded as a plugin**, so the extension is one self-contained file (no sibling helper). `~/.opencode/` joins the config trees (§5). Later-loaded plugins run after jev-cops (row 9). |
| 3 | Plugin API | "`tool.execute.before` … throw to block; mutate `output.args` to rewrite; `permission.ask` hook in flux" | `packages/plugin/src/index.ts` `Hooks`: `"tool.execute.before"?: (input: { tool, sessionID, callID }, output: { args: any })`, `"tool.execute.after"?: (input: { tool, sessionID, callID, args }, output: { title, output, metadata })`, `"permission.ask"?: (input: Permission, output: { status: "ask" \| "deny" \| "allow" })`, `"chat.message"?: (input: { sessionID, agent?, model?, messageID? }, output: { message: UserMessage; parts: Part[] })`, `event?: ({ event })`, `"shell.env"`, `"command.execute.before"`, `"tool.definition"`, `tool?` (custom tools), `dispose?`. `PluginInput`: `client`, `project`, `directory`, `worktree`, `serverUrl`, `$` ("`typeof Bun === "undefined" ? undefined : Bun.$`"). | The plugin uses `node:http` with `socketPath` (works under Bun and Node; the input hints the host may not be Bun) — the same transport code as the Pi extension, kept byte-identical by a test. `permission.ask` is declared but `permission/index.ts` publishes `Event.Asked` and awaits a reply without calling any plugin hook, and no `trigger("permission.ask"` exists in the files read: treated as unavailable (the spec's "in flux" stands). |
| 4 | Blocking | "throw to block" | `session/tools.ts`: `yield* plugin.trigger("tool.execute.before", …, { args })` then `item.execute(args, ctx)` inside `run.promise(Effect.gen(…))`; `plugin/index.ts` `trigger`: `yield* Effect.promise(async () => fn(input, output))` for each hook in order. `session/prompt.ts` (task path): a failure becomes `state: "error"`, `error: "Tool execution failed: <message>"`; `session/processor.ts` `failToolCall` sets `status: "error"`, `error: errorMessage(error)`. plugins.mdx example: `throw new Error("Do not read .env files")`. | A throw before `execute` stops the tool and the model reads the error text: `deny` = `throw new Error("jev-cops: <reason>")`. The session continues (no turn stop). No other plugin runs after a throw (sequential), so a later plugin cannot un-block. |
| 5 | Rewrite | "mutate `output.args` to rewrite" | `tools.ts` passes `{ args }` and then calls `item.execute(args, ctx)` with the **original** `args` binding. | Replacing `output.args` is ignored; the plugin must mutate keys in place (delete absent keys, assign the rest), exactly like Pi's `event.input` (D-056). Verified live (§6.3). |
| 6 | Hook failure and timeouts | — | No timeout around `trigger`; `plugin/index.ts` loads external plugins with `Effect.catch(() => Effect.void)` after logging ("TODO: make proper events for this"), publishing a `Session.Event.Error` only for install/compatibility/entry stages. `run --pure`: "run without external plugins"; `OPENCODE_PURE`, `OPENCODE_DISABLE_PROJECT_CONFIG` (`flag.ts`). | A plugin that fails to import is skipped **silently** (gate off, no message in `run`); a hung hook hangs the tool forever. The plugin owns its 13 s deadline and throws on it (T3); doctor's canary imports the installed file. `--pure` and the two variables are printed gaps and `harness-config` flags. |
| 7 | `tool.execute.after` (#27900) | "fires on success only" | Issue #27900 closed 2026-08-16 by the stale bot ("not_planned"); draft PR #32542 (`tool.execute.error`) unmerged; `tools.ts` triggers `after` only after `execute` succeeded. `event` hook receives every bus event: `message.part.updated` with a `ToolPart` (`callID`, `tool`, `state: { status: "error", input, error }`). | Post events for successes from `after` (awaited, ≤ 2 s); for failures from `event` (`message.part.updated`, `state.status === "error"`), fire-and-forget by the host (`void hook["event"]?.(…)`): best effort, taint may register late (printed). |
| 8 | Subagents (#5894) | "plugin hooks have not fired for subagents spawned via the task tool" | Issue closed 2026-04-15 (stale); maintainers: "plugins are loaded per-Instance so the hooks DO fire for the subagent's tools … What probably happened is the general agent used bash to run grep/glob as shell commands"; the same comment: "`batch.ts` calls `tool.execute()` directly without going through `Plugin.trigger()`" — `batch.ts` no longer exists in `dev`. `tool/task.ts`: the child session is created with `parentID: ctx.sessionID`; `session/prompt.ts` triggers `tool.execute.before` for `task` with `{ prompt, description, subagent_type, command }`. SDK `Session.parentID?`, `client.session.get`. | Subagent calls are judged; `input.sessionID` is the child's, so the plugin resolves `parentID` (cached from `session.created` events, else `client.session.get`) to send `sess_<child>` with `parent_id: sess_<parent>` and `actor.kind: "subagent"` (D-075 keeps the task from a child prompt). `task` is `spawn`. Live capture asserts a subagent `bash` reaches copsd; the gap line stays until then and names `batch`-like bypasses. |
| 9 | Plugin order | — | "all hooks run in sequence" in load order (row 2). | A plugin loaded after jev-cops can re-mutate `output.args` after the judge (a TOCTOU the Claude Code docs call "the last one to finish takes effect"). Doctor lists every other plugin (`plugin` config + both directories) as a warning; a project plugin always runs after a global jev-cops. |
| 10 | Desktop (#38604) | "have not fired in the Desktop app" | Issue closed 2026-09-24 as "not_planned" by the stale bot ("plugins load and register but their hooks … are never invoked"). `opencode --help`: `serve`, `run --attach <url>`. | Gap printed by installer and doctor; not verified here (no Desktop app installed; owner question §8). Under `serve` + `--attach` the plugin runs in the server process. |
| 11 | Tool names and args | — | `tool/registry.ts` registers `bash` (`tool/shell/id.ts`: "Keep the exposed tool ID and permission key as "bash" … Rename with opencode 2.0"; shell kinds `bash`, `pwsh`, `powershell`, `cmd`), `edit` (`filePath`, `oldString`, `newString`, `replaceAll?`), `write` (`content`, `filePath`), `read` (`filePath`, `offset?`, `limit?`), `glob` (`pattern`, `path?`), `grep` (`pattern`, `path?`, `include?`), `task` (`prompt`, `description`, `subagent_type`, `background?`), `webfetch` (`url`, `format`, `timeout?`), `websearch` (`query`, …), `apply_patch` (`patchText`), `skill` (`name`), `lsp` (`operation`, `filePath`, `line`, `character`), `todowrite`, `question`, `plan_exit`, `execute` (code mode, `code`), `invalid`; no `list`/`ls` and no `todoread` tool exist in `dev`; MCP tools `McpCatalog.toolName` = `sanitize(client) + "_" + sanitize(tool)`; MCP resource tools `list_mcp_resources`, `list_mcp_resource_templates`, `read_mcp_resource`. | Core rows in §5. The `bash` arguments are `command`, optional `timeout` ("in milliseconds") and `workdir` (`tool/shell/prompt.ts`): core's existing lower-case `bash` rule (Pi) applies unchanged. MCP tools are indistinguishable from custom tools by name (`server_tool`): `other`, scored like exec. |
| 12 | Permissions and auto mode | — | permissions.mdx: `permission` rules `allow`/`ask`/`deny` per tool with patterns; "By default, opencode **allows all operations** without requiring explicit approval"; `--auto` "auto-approve permissions that are not explicitly denied"; `OPENCODE_PERMISSION` env merges rules. | No refusal (a plugin throw blocks regardless of permission rules); installer warns on `--auto`, a global `"allow"`, and `OPENCODE_PERMISSION`. Holds are denies (no ask, row 3). |
| 13 | Headless | — | `opencode run` "non-interactive mode"; `--format json`; the same server serves TUI, `run`, `serve` and the Desktop; no mode field reaches plugins. | In-process detection: `process.argv` of the host (`run`/`serve`/`web` → headless; `tui`/no subcommand → interactive; under `--attach` the client is unknown → headless). Mode only feeds the environment feature since holds deny anyway. |
| 14 | Kill | "session terminated" | SDK: `client.session.abort({ path: { id } })` (`POST /session/{id}/abort`); `chat.message` cannot reject a message. | `kill` = throw + `client.session.abort` (best effort, 2 s) + daemon latch; a later `chat.message` of a latched session (reply `killed: true`) aborts it again and reports. |
| 15 | Task capture | "first user prompt" | `chat.message` receives `output.message: UserMessage` and `parts` (text parts) before the model runs; fires for child sessions too. | First root prompt → `/v1/session prompt` (T11); child sessions carry `parent_id` so theirs never pin. |
| 16 | Config and data | — | `Global.Path`: `config` `$XDG_CONFIG_HOME/opencode`, `data` `$XDG_DATA_HOME/opencode` (`log/`, `repos/`, sessions), `cache` (`node_modules` of npm plugins), `state`; `OPENCODE_CONFIG`, `OPENCODE_CONFIG_DIR`, `OPENCODE_CONFIG_CONTENT`; `.opencode/{plugins,agents,commands,skills,tools,themes}`; custom tools in `tools/` are code loaded in-process. | Config trees (§5): kill `plugin(s)/`, `tool(s)/`, `opencode.json[c]`; hold the rest; `~/.local/share/opencode/auth.json` is a credential file (secret read). |
| 17 | Provider for a fake API | — | providers.mdx: "You can customize the base URL for any provider by setting the `baseURL` option"; custom providers via `"npm": "@ai-sdk/openai-compatible"` (needs `bun install` at startup). | Live capture uses the bundled `openai` provider with `options.baseURL` at the local fake Responses API and a dummy `apiKey` (no npm install, no network). |

Releases since v1.15 (the version #27900 cites): the last ten release notes (`v1.18.24`–`v1.18.33`) mention no plugin-hook change; "apply_patch no longer emits an empty move path in permission metadata" (v1.18.26) is the only tool-contract line.

### 2.3 Pi (adapter verified at v0.87.1; latest v0.99.1, 2026-09-29; the only releases in between are 0.99.0/0.99.1)

| # | Fact | Was (0.87.1) | Now (0.99.1, source and quote) | Consequence |
|---|---|---|---|---|
| 1 | `tool_call`/`tool_result` contract | block by `{ block, reason, terminate }`, mutate `event.input` | Unchanged: types.ts "Block tool execution. To modify arguments, mutate `event.input` in place instead."; "Hint that the agent should stop after the current tool batch"; docs "A `tool_call` handler failure blocks the tool as a fail-safe". | Adapter unchanged. |
| 2 | Nested calls | — | CHANGELOG 0.99.0: "`ctx.executeTool()` for nested tool calls, which emit events with `parentToolCallId`"; types: "pi assigns `<parent id>/<n>`"; nested calls "go through argument validation and the `tool_call` and `tool_result` handlers like model-issued calls". | Judged already (same handlers); `call_<parent>/<n>` is a valid `call_` id and the daemon pairs pre and post by it. `parentToolCallId` has no field in the canonical schema and is not sent (the parent is visible in the id). |
| 3 | MCP and built-ins | — | 0.99.0: "codemode, tool search, and MCP support as built-in extensions"; Unreleased: "MCP tool and namespace names now replace `-` with `_` (`mcp__my-server__x` is now `mcp__my_server__x`)"; "`--no-extensions` also disables the built-in extensions". | `mcp__s__t` names reach core's `canonicalTool` (`mcp:s:t`). `PI_GAPS` line for `--no-extensions` unchanged. |
| 4 | Tool annotations | — | `ToolAnnotations` (`readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint`) via `pi.getAllTools()`; "The hints are not verified". | Not used: an unverified hint must not widen the fail-open set, and classification stays in core (D-054). Unknown tools stay `other`. |
| 5 | `user_bash` | present, unused | Unchanged: "A `user_bash` handler that returns `undefined` passes the command to the next handler … A handler failure blocks the command". | Optional parity item (§4, not in the line budget). |
| 6 | `shutdown()` in print mode | no-op | types.ts says "Available in all contexts"; `print-mode.ts` still binds no shutdown handler (diff empty). | `PI_GAPS` line unchanged; `ctx.abort()` stays the headless kill. |
| 7 | Version exposure | none | none (`types.ts` has no version field). | Install records `pi --version` (§4). |
| 8 | Subagents | none built in | `examples/extensions/subagent` spawns "a separate `pi` process" per agent. | Unchanged gap ("nested agents started by other extensions are not linked"); the child `pi` loads a global jev-cops extension and is its own root. |
| 9 | SkillSpector coexistence | — | PI_EXTENSION.md: "registers a `skillspector_scan` tool that runs the existing SkillSpector CLI", installed with `pi install <path>`; no `tool_call` handler. OPENCODE_EXTENSION.md: `.opencode/tools/skillspector_scan.ts` custom tool plus `/skillspector` command; "the tool asks OpenCode for the capabilities used by that invocation … A denied request stops the invocation". | No handler overlap: jev-cops judges `skillspector_scan` as `other` on both (fails closed when copsd is down); its CLI subprocess is not a judged exec (spawned in-process). Nothing to change; the setup track's scanner uses the CLI directly. |

## 3. Adapter designs

### 3.1 Codex

**Transport.** `dist/cops-hook --harness codex --socket <path>` (later `--url`, M2 step 6),
registered as one shell string per event in `hooks.json`:

```json
{ "description": "jev-cops hooks (cops install codex)",
  "hooks": { "PreToolUse": [{ "hooks": [{ "type": "command",
      "command": "'/abs/dist/cops-hook' --harness codex --socket '/home/you/.jev-cops/copsd.sock'",
      "timeout": 30, "statusMessage": "jev-cops" }] }],
    "PostToolUse": [ … "timeout": 15 ], "UserPromptSubmit": [ … 10 ], "SessionStart": [ … 10 ], "SessionEnd": [ … 3 ] } }
```

The hook binary gains harness dispatch in a harness-neutral runtime package (step 0, §6):
`packages/hook` owns the process shell (exit 2 first, fatal handlers, synchronous writes,
deadlines, local log, parent-process reader, socket client); `adapters/claude-code` and
`adapters/codex` each provide `payload → event → verdict → output` for their harness. The
Codex payload parser is the Claude Code one (schemas match on every field jev-cops reads);
`model` is additionally read into `actor.model`.

**Event mapping.** `PreToolUse` → `/v1/judge` (deadline 13 s); `PostToolUse` → `/v1/observe`
(≤ 2 s; `ok` false when the response reports a non-zero `exit_code` or an `error`);
`UserPromptSubmit` → `/v1/session prompt` (blocks with `decision: "block"` + exit 2 when
`killed`); `SessionStart` → `start` (`model`, `source`); `SessionEnd` → `end`. Session ids
`sess_<session_id>[.<agent_id>]` (D-070); `harness_version` from `~/.jev-cops/codex.json`.

**Verdict mapping (tighten-only; table `adapters/codex/src/output.ts`).**

| verdict | Codex hook output |
|---|---|
| allow | exit 0, no output |
| annotate | exit 0, `{"hookSpecificOutput":{"hookEventName":"PreToolUse","additionalContext":"jev-cops: <note>"}}` |
| rewrite | exit 0, `{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"allow","updatedInput":{"command":"<pinned>"}}}` for `Bash` only; any other tool or a payload without a string `command` → deny "rewrite unsupported" |
| hold | deny (no ask on Codex, D-008) with reason "held by jev-cops: <reason>; a human can approve with `cops grant <event-id>` and retry" — the reason only, never the raw command or summary (T8: the reason reaches the model) |
| deny | exit 2, stderr `jev-cops: <reason>`, stdout JSON deny with the same reason (ignored at exit 2, kept for parity) |
| kill | deny; the daemon latch (D-076) answers every later call; the next `UserPromptSubmit` is blocked. Never `continue: false` (unsupported: it would fail the run and let the tool proceed) |

Fail-open set when the daemon is unavailable: `view_image` (`fs.read`) and core's inert tools;
everything else, `Bash` and `apply_patch` and MCP included, fails closed (no Read tool exists,
so reads through `cat` are judged like every shell command, per the spec).

**Task capture and headless.** As Claude Code (`/v1/session`, D-075). Mode from the parent
chain: `$SHELL -lc` → `codex` argv; `exec`, `e`, `review`, `exec-server`, `app-server`,
`mcp-server` → headless; `codex`, `resume`, `fork` → interactive; unreadable → headless.
`permission_mode` is reported on every session report (D-078).

**Config-change detection.** None from the harness (§2.1 row 20). `config-tamper` covers
`$CODEX_HOME/{config.toml,hooks.json,rules}`; doctor compares `hooks.json` with the installed
entries; the hook logs a warning when its own argv differs from the recorded install
(`~/.jev-cops/codex.json`), which catches an edited command string at the next call.

**Fail-closed analysis (Codex).**

| # | Path where a tool could run unjudged | Closed by | Residual |
|---|---|---|---|
| 1 | Hook not trusted: "skipped until trusted" | Installer prints the `/hooks` step; doctor reads `[hooks.state]` and runs the canary; managed install needs no trust | Between install and trust every call is unjudged, **silently**. Printed. |
| 2 | Missing/mistyped binary, profile output on stdout, other exit code, crash, timeout → `Failed` → continues | Exit 2 first, fatal handlers, stderr always written, 13 s deadline < `timeout: 30`; canary through `$SHELL -lc` | SIGKILL/OOM of the hook (same as Claude Code). Printed. |
| 3 | Unsupported JSON field → `Failed` → continues | Output table emits only supported fields; a unit test diffs every emitted body against the generated output schema (`pre-tool-use.command.output.schema.json`, fetched into `tests/fixtures/codex/`) | Schema drift in a future release: doctor warns above the verified version. |
| 4 | Daemon unreachable / non-200 / 504 / wrong event id | exit 2 fail closed except `view_image` and inert tools (systemMessage + local log) | — |
| 5 | `write_stdin` into a running exec session | `interactive-shell` verb → `opaque-exec` hold (deny on Codex); Codex's own stdin approval (`unified_exec/stdin_approval.rs`) is outside our control | A non-interactive first command that later reads stdin. Printed; OpenShell floor. |
| 6 | Hosted tools (`WebSearch`), "specialized tool paths" | Nothing | Printed. |
| 7 | `[features] hooks = false`, `allow_managed_hooks_only`, `--disable hooks`, `-c features.hooks=false`, `--dangerously-bypass-hook-trust` (loosens nothing: it runs hooks), `--ignore-user-config`, untrusted project layer | Installer refuses the first two for a user install; `harness-config` verb holds a nested `codex` with these flags; managed install pins `[features].hooks = true` | Printed. |
| 8 | `hooks.json` edited mid-session | `config-tamper` kill on the write; re-read behaviour unverified | Printed. |
| 9 | Another hook's `updatedInput` | Concurrent hooks; "any deny wins" only for `PermissionRequest`; PreToolUse: our block wins (`should_block`), but two `updatedInput`s race | Doctor warns on any other PreToolUse handler. |
| 10 | `kill` does not end the turn | Latch + prompt block | The model finishes its turn with every call denied. Printed. |
| 11 | Subagent calls | `agent_id` per event, same latch root | Verified live; printed until then. |
| 12 | `.rules` skipped by `--ignore-rules`, `--yolo`, or not consulted for sandboxed commands | Rules are a second line only; `harness-config` verb on the flags | Printed. |

**Installer (`cops install codex`).** Scopes `--user` (default, `$CODEX_HOME` else `~/.codex`),
`--project` (`<repo>/.codex/hooks.json`, warns when `projects."<path>".trust_level` is not
`trusted`), `--managed` (root only; writes `/etc/codex/requirements.toml` fragment or prints
it). Merge: remove entries whose command names `cops-hook`/`cops hook` with `--harness codex`,
append one group per event; keep foreign groups and key order; backup `<file>.jev-cops-<UTC>.bak`;
atomic write; 0600. Refusals (exit 1, nothing written; `--force` → `FORCED:`): `[features]
hooks = false` (or `codex_hooks = false`) in `config.toml`; `allow_managed_hooks_only = true`
for a non-managed scope; an inline `[hooks]` jev-cops entry pointing at another socket; a hook
binary or socket path containing `'`, NUL or newline. Warnings: `approval_policy = "never"` or
`sandbox_mode = "danger-full-access"` (holds are denies anyway; noted), an existing
`[hooks.state]` entry with `enabled = false` for our key, `--managed` when `managed_dir` differs
from the binary's directory, "Without OpenShell, every deny is best-effort", `--yolo` out of
scope. Always printed: the trust step ("open `codex`, run `/hooks`, trust the 5 jev-cops
handlers; until then Codex skips them silently; re-run after any change"), then `CODEX_GAPS`.
Records `~/.jev-cops/codex.json` (`codex_version`, `hooks_path`, `rules_path`, `socket`,
`hook_binary`, `scope`, `installed_at`) and `[daemon] hook_binary` (shared with Claude Code).
Rules: writes `$CODEX_HOME/rules/jev-cops.rules` unless `--no-rules`, validated with `codex
execpolicy check --rules <file> -- pkill copsd` when `codex` is on `PATH` (expects `forbidden`);
`--uninstall` removes both. Offline canary: the `PreToolUse` command read back from the file,
run through `$SHELL -lc` with `HOME`/`PATH` only, payloads `Bash` `true` → exit 0 empty, `Bash`
`echo x > <home>/.codex/hooks.json` → exit 2 JSON deny (kill); outcomes as D-091.

**Execpolicy fragment (`adapters/codex/src/rules.ts`, the same lists as `policies/_lib/judge-guard.ts`, asserted equal by a test):**

```python
prefix_rule(pattern=["pkill", ["copsd", "cops-hook"]], decision="forbidden", justification="Stopping the jev-cops judge blocks every later call; ask a human.", match=["pkill copsd"], not_match=["pkill node"])
prefix_rule(pattern=["pkill", "-f", ["copsd", "cops-hook"]], decision="forbidden", …)
prefix_rule(pattern=["killall", ["copsd", "cops-hook"]], decision="forbidden", …)
prefix_rule(pattern=["cops", ["budget", "install", "grant", "keygen", "openshell", "explain", "replay"]], decision="forbidden", justification="jev-cops admin commands are for humans in a terminal.")
prefix_rule(pattern=["cops-hook"], decision="forbidden", justification="The judge's hook is not a tool.")
prefix_rule(pattern=["codex", ["--dangerously-bypass-hook-trust", "--ignore-rules", "--ignore-user-config", "--disable"]], decision="prompt", …)
prefix_rule(pattern=[["claude", "codex", "opencode", "pi"]], decision="prompt", justification="A nested agent runs unjudged unless jev-cops is installed for it.")
```

**Doctor (`cops doctor --harness codex`).** `codex --version` vs recorded and vs verified
(0.153.4 here; warn on drift, note the docs are at `main`); `hooks.json` parses, our five
entries present with the running binary, socket and timeouts ≥ the hook's deadlines; `config.toml`:
`features.hooks`, `allow_managed_hooks_only`, `[hooks.state]` trust for each of our keys
(`warn` "not trusted: run /hooks"), project trust for project installs, other PreToolUse
handlers (warn), `approval_policy`/`sandbox_mode` (info); rules file present and `codex
execpolicy check` agrees on the inline `match` examples; state file; offline canary as above;
`--live` (`JEV_COPS_LIVE_CANARY=1`, bills the user's account): `codex exec --json
--skip-git-repo-check -s read-only -a never -C <tmp> "Run exactly this shell command and nothing
else: printf jev-cops-canary-<nonce>"`, expects a `judge` line with the nonce; when none,
re-runs with `--dangerously-bypass-hook-trust` and, if the line then appears, reports "hooks
registered but not trusted". Then every `CODEX_GAPS` line.

**What OpenShell (M2) later closes.** The hook is `cops-hook`, a child of `$SHELL` under `codex`:
the `jev_cops_judge` rule lists the hook binary alone (hash-pinned), the model's shell commands
are not its descendants and have no route (D-105/D-111, same as Claude Code). The managed
`requirements.toml` at `/etc/codex` is baseline read-only in the image, so the trust step
disappears and `[features].hooks = true` is pinned; `~/.codex/{config.toml,hooks.json,rules}`
are `read_only` in the protection fragment while `sessions/`, `log/`, `history.jsonl`,
`memories/` stay writable. `write_stdin`, hosted tools and the un-trusted window are what the
kernel floor is for (T4). The execpolicy rules stay a second line inside the sandbox.

### 3.2 OpenCode

**Transport.** `adapters/opencode/jev-cops.ts`, one file, Node built-ins only, `INSTALLED_SOCKET`
baked by the installer (later `INSTALLED_URL`, M2). Export shape: `export const JevCops: Plugin =
async ({ client, directory }) => ({ … })`. The daemon client (`send`, `parseVerdict`, `mintEventId`)
is the Pi extension's code; a test asserts the two copies are identical.

**Hooks used.**

| Hook | Use |
|---|---|
| `tool.execute.before` | build the pre event (`sess_<sessionID>`, `parent_id` from the session cache, `call_<callID>`, `tool`, `input: output.args` verbatim, `cwd: directory`), `/v1/judge` under a 13 s deadline; `rewrite` mutates `output.args` keys in place; `hold`/`deny`/`kill` throw `Error("jev-cops: <reason>")`; `kill` also `client.session.abort({ path: { id } })` (≤ 2 s); `annotate` stores the note for `after` |
| `tool.execute.after` | `/v1/observe` (ok true, sha256/head/bytes of `output.output`) awaited ≤ 2 s; appends `\n[jev-cops] <note>` to `output.output` |
| `chat.message` | first root prompt → `/v1/session prompt` (text parts joined); reply `killed: true` → `client.session.abort` + a `client.app.log` warning |
| `event` | `session.created` → cache `{ id, parentID }`; `message.part.updated` with `part.type === "tool"` and `state.status === "error"` → `/v1/observe` with `ok: false` (best effort); `session.idle`/`session.deleted` of a root → `/v1/session end` |
| `config` | records the effective `permission` posture and `plugin` list for the log (informational) |

Best-effort `kind` table (the daemon reclassifies): `bash` → exec; `read`/`glob`/`grep`/`lsp` →
fs.read; `edit`/`write`/`apply_patch` → fs.write; `webfetch`/`websearch` → net; `task` → spawn;
everything else `other`. Fail-open set: the fs.read tools only.

**Verdict mapping.**

| verdict | OpenCode |
|---|---|
| allow | return |
| annotate | return; note appended to the result in `after` (success only) |
| rewrite | keys absent from `updated_input` deleted from `output.args`, the rest assigned (D-056) |
| hold | throw with the verdict reason plus the `cops grant <event-id>` pointer (no confirm UI, D-008) |
| deny | throw `jev-cops: <reason>` |
| kill | throw + `session.abort`; daemon latch; later `chat.message` aborts again |

**Task capture and headless.** `chat.message` (row 15). Mode from `process.argv` (row 13),
reported with every session report; `--auto` and a global `"allow"` are reported as
`permission_mode: "bypassPermissions"` so the daemon's no-human flag applies (D-078).

**Config-change detection.** None from the harness; `config-tamper` trees (§5); doctor compares
the installed file with this release's source (as Pi).

**Fail-closed analysis (OpenCode).**

| # | Path | Closed by | Residual |
|---|---|---|---|
| 1 | Plugin fails to import (syntax, missing dep) → skipped silently | Installer verifies by importing the written file under Bun; doctor imports it and runs the canary | A Bun/Node incompatibility at the host's runtime version. Printed. |
| 2 | `--pure`, `OPENCODE_PURE`, `OPENCODE_DISABLE_PROJECT_CONFIG` (project install), `OPENCODE_CONFIG_DIR` pointing elsewhere | `harness-config` verb on a nested `opencode` with them; global install by default | Printed. |
| 3 | Daemon unreachable / slow / bad reply | throw (fail closed) except the fs.read tools (log line + `client.app.log`); own 13 s deadline (no host timeout exists) | — |
| 4 | Desktop app never invokes hooks (#38604) | Nothing | Printed; owner question §8. |
| 5 | Tool paths that bypass `Plugin.trigger` (the old `batch` tool) | Live capture over subagent, MCP, code-mode `execute` and custom tools; each trigger site in `session/tools.ts`/`prompt.ts` is listed in the capture | Printed as "any tool path added without `Plugin.trigger`". |
| 6 | A later plugin re-mutates `output.args` | Doctor warns on every other plugin; project installs load last | Printed. |
| 7 | Failed calls have no `after` | `event` observation, host fire-and-forget | Taint of an error output may register after the model reads it. Printed. |
| 8 | `kill` cannot stop the current tool batch | abort + latch | Printed. |
| 9 | `serve` + `--attach`, remote server (`OPENCODE_SERVER_*`) | plugin runs in the server; client mode unknown → headless | Printed. |
| 10 | MCP and custom tools named like built-ins | `other`, scored like exec; a plugin tool "takes precedence" over a built-in of the same name (plugins.mdx) | Doctor lists plugin-provided tools. |

**Installer (`cops install opencode`).** `--global` (default; `$OPENCODE_CONFIG_DIR` else
`$XDG_CONFIG_HOME/opencode` else `~/.config/opencode`) or `--project` (`<project>/.opencode`);
writes `plugins/jev-cops.ts` (creates the plural dir; warns when a `plugin/` sibling exists),
bakes `--socket`, `--dry-run`, `--uninstall` (only a file carrying the `INSTALLED_SOCKET` line),
`--json`. Verification: imports the written file with Bun and calls it with a stub `PluginInput`
(a client whose every method rejects) to check it returns the six hooks; then the offline canary
(`bash` `true` → no throw; `write` of `<home>/.config/opencode/opencode.json` → throw with
`kill`). Warnings: `--auto` in the user's shell history is unknowable, so the warning names the
flag; `permission` `"allow"` globally or for `bash`; `OPENCODE_PERMISSION` set; other plugins
present (order); `OPENCODE_PURE`; Desktop gap; "Without OpenShell, every deny is best-effort".
Records `~/.jev-cops/opencode.json` (`opencode_version`, `path`, `socket`, `scope`). Prints
`OPENCODE_GAPS`.

**Doctor (`cops doctor --harness opencode`).** File present in either location, baked socket vs
copsd's, content identical to this release's, `opencode --version` vs recorded and vs 1.18.33,
`opencode.json[c]` (global and project): `plugin` list, `permission` posture, `OPENCODE_*` env;
in-process canary (import + two calls, as the installer); then `OPENCODE_GAPS`. `--live`
(`JEV_COPS_LIVE_CANARY=1`): `opencode run --format json "Run exactly … printf jev-cops-canary-<nonce>"`
and looks for the nonce in a `judge` line (bills the user's provider).

**What OpenShell (M2) later closes.** The plugin runs inside the `opencode` process, so every
tool it spawns inherits its network identity (the Pi situation, D-111): the judge route lists the
`opencode` binary, in-sandbox resolves grant nothing, self-minted judges are bounded by the
budget. `~/.config/opencode/{plugins,opencode.json,opencode.jsonc}` `read_only`;
`~/.local/share/opencode` and `~/.cache/opencode` `read_write`; a project `opencode.json` inside
the writable repo stays kernel-writable (printed, like Claude Code's project settings). The
Desktop and `batch`-class gaps are what the kernel floor covers (T4).

## 4. Pi parity (vs the Claude Code adapter)

| Item | Claude Code | Pi today | Change (line cost) |
|---|---|---|---|
| Session route (`/v1/session`) | `start`/`prompt`/`end`/`config-change` | task sent inline in every event (D-058); nothing on start/end | `session_start` → `start` (`reason` mapped to a documented source: `new` → `startup`, `reload` skipped; `ctx.model?.id`); `before_agent_start` → `prompt` (first pins, T11; keep the inline task for older daemons); `session_shutdown` → `end` (reason `quit`/`new`/`resume`/`fork`, not `reload`) (+14) |
| Kill latch | `UserPromptSubmit` blocked when `killed` | latch answers `/v1/judge` already; a new prompt of a killed session still reaches the model | `before_agent_start`: when the `prompt` report answers `killed: true` → `ctx.ui.notify` + `ctx.abort()` (+4) |
| Confirm summary (D-096) | ask text = reason + raw + summary + `cops explain` | same (done 2026-09-30) | none |
| View vs hold token | view-only token, no precedent (D-079) | hold token, resolve → precedent (D-059); under OpenShell allow-once (D-111) | none: Pi has a real confirm |
| Headless detection | parent argv, `/bin/ps` | `ctx.hasUI` (`rpc` counts interactive) | none; report `permission_mode` absent |
| `harness_version` | recorded by install (D-076) | none | `cops install pi` records `pi --version` in `~/.jev-cops/pi.json`; doctor warns on drift from the verified 0.99.1; the extension still sends none (0 in the extension) |
| Install refusals/warnings | 10 | gaps only | warn when `~/.pi/agent/settings.json` lists `-jev-cops`-style disabled extensions or when a project install is untrusted (settings readable), `pi --no-extensions` note (+0 extension) |
| Doctor canary | offline through the registered binary | content compare only | `adapters/pi/canary.ts`: import the installed file under Bun with the fake Pi runtime (`testing/fake-pi.ts` moved to a runtime-safe module), drive `tool_call` `bash true` → allow and `write ~/.pi/agent/settings.json` → block (kill); shared by install and doctor (D-095 parity) |
| Post events awaited | ≤ 2 s | ≤ 2 s | none |
| Task capture | first prompt via daemon | first prompt inline + now via daemon | above |
| Local log | `~/.jev-cops/claude-code-hook.log` | notify/stderr | `~/.jev-cops/pi-extension.log` append on failures (+6) |
| Nested calls (0.99) | n/a | judged; ids `<parent>/<n>` | test only |
| `user_bash` (optional) | n/a | not observed | later: `/v1/observe`-style report with `actor.kind: "user"`, never blocked (+8; deferred) |

The extension is at 147 logic lines; the parity items add about 24. Proposal (M3-9): the 150-line
rule becomes ≤ 200 logic lines for a single-file extension (Pi, OpenCode), since neither host can
load a helper file next to it (OpenCode loads every file in `plugins/` as a plugin; a Pi
subdirectory with `index.ts` is possible but doubles the install/doctor identity surface). The
Claude Code and Codex adapters are packages and are bound by "no policy logic", not by lines.

## 5. Core and policy changes (`packages/core`, `policies/`)

```ts
// normalizer/tools.ts (D-054: names live here, never in adapters)
// Codex (hook boundary names, §2.1 row 10): Bash already present
apply_patch:   { reader: "patch", field: "command" }        // new reader, §2.1 row 11
view_image:    { reader: "path", fields: ["path"], kind: "fs.read", access: "read" }
...all(SPAWN, ["spawn_agent", "followup_task", "send_input", "send_message", "resume_agent"])  // alias spawn_agent → Task
...all(INERT, ["update_plan", "request_user_input", "get_context_remaining", "current_time", "sleep",
               "tool_search", "new_context_window", "wait_agent", "list_agents", "close_agent", "interrupt_agent"])
// request_plugin_install, request_permissions: absent on purpose → other (scored like exec, fail closed)
// OpenCode (ids from tool/*.ts, §2.2 row 11)
bash already present (Pi); edit/write: { reader: "path", fields: ["filePath"], kind: "fs.write", access: "write" } — but Pi's
  `edit`/`write` read `path`: fields become ["path", "filePath"] on the shared lower-case rules (first string wins)
read: fields ["path", "filePath"]; glob/grep: ["path"]; lsp: { reader: "path", fields: ["filePath"], kind: "fs.read", access: "read" }
webfetch: { reader: "url", field: "url" }; websearch: NET; task: SPAWN (alias → Task); apply_patch (patchText): { reader: "patch", field: "patchText" }
skill: not listed on purpose (it loads instruction text: `other`, scored like exec); todowrite/question/plan_exit: INERT
execute (code mode): { reader: "shell" } (opaque interpreter: model-written JavaScript)
// TOOL_ALIASES: task → Task, spawn_agent → Task, apply_patch → Edit, webfetch → WebFetch, websearch → WebSearch, execute → Bash
// new reader { reader: "patch"; field: string }: normalizer/patch.ts parses the apply_patch grammar
//   Add/Update → write, Delete → delete, Move to → write target + delete source; "+" lines feed content taint (T10)
// classify.ts / interpreters.ts: a bare shell or REPL with no script and no -c (bash, sh, zsh, python, node, irb, …)
//   gets verb "interactive-shell" (kind exec stays); opaque-exec@2 holds it ("accepts later commands jev-cops cannot see")
// harness.ts: codex flags ["--dangerously-bypass-hook-trust","--ignore-rules","--ignore-user-config","--disable","--enable","-c","--config","--profile"];
//   opencode flags ["--pure"] and env prefixes OPENCODE_PURE/OPENCODE_DISABLE_PROJECT_CONFIG/OPENCODE_CONFIG/OPENCODE_CONFIG_DIR/OPENCODE_CONFIG_CONTENT (D-114 pattern)
// context/secrets.ts: harness credential files count as secret reads: ~/.codex/auth.json, ~/.local/share/opencode/auth.json, ~/.claude/.credentials.json
// schema: no change (harness enum has codex/opencode; permission modes admit Codex's five)
```

`policies/_lib/config-trees.ts` rows (data only, one commit rebased after the `config-tamper`
fix lands): codex home `rules` add `plugins: "kill"`; absolute `/etc/codex` kill, `/c/programdata/
openai/codex` kill; opencode home `.config/opencode` rules add `tool: "kill"`, `tools: "kill"`;
new home tree `.opencode` (rest hold, `plugin`/`plugins`/`tool`/`tools` kill); project
`.opencode` rules add `tool`/`tools` kill; the `config-trees.test.ts` table gains the rows.
`policies/opaque-exec.ts` v2 + fixtures (interactive shell → hold). Fixtures: `tests/fixtures/
commands/commands.json` rows for the patch reader and interactive shells; `tests/fixtures/
codex/*.json` and `tests/fixtures/opencode/*.json` documented payloads (from the schemas and
sources, then replaced by captured ones in step 9).

Verification of the existing trees against the docs: Codex `~/.codex/{config.toml,hooks.json,
rules}` kill and project `.codex` kill are right; OpenCode `plugin`/`plugins` kill are right,
`opencode.json[c]` kill right; Pi unchanged. Missing pieces are the additions above.

## 6. Build order, file ownership, live captures

### 6.1 Steps and gates

| # | Module | Delivers | Gate | Owns (M3 only) |
|---|---|---|---|---|
| 0 | `packages/hook` extraction | harness-neutral hook runtime moved out of `adapters/claude-code` (`process.ts`, `client.ts`, `deps.ts`, `hook.ts` dispatch, `output.ts` primitives, `log.ts`, `mode.ts` parent reader, `args.ts` with a harness enum); Claude Code keeps its mapping and re-exports; `hook-main.ts` moves and dispatches `--harness claude-code\|codex`; `build:hook` entry updated | every adapter-claude-code test green unchanged; `dist/cops-hook` byte-equivalent behaviour on the M1 e2e suite; p50 cold start unchanged | `packages/hook/**`, `adapters/claude-code/src/{process,client,deps,hook,log,mode,args,hook-main}.ts` (moves), `package.json` `build:hook` |
| 1 | core | §5 rules, patch reader, interactive-shell verb, harness flags, credential files, fixtures | core tests; commands table rows; `bun run gate` unchanged except the listed opaque-exec additions | `packages/core/src/normalizer/{tools,normalize,patch,classify,interpreters,harness}.ts`, `context/secrets.ts`, `tests/fixtures/{commands,codex,opencode}/` |
| 2 | policies | config-tree rows; `opaque-exec@2` fixtures | `bun run gate` | `policies/_lib/config-trees.ts` (+test), `policies/opaque-exec.ts` + fixtures |
| 3 | `adapters/codex` runtime | `src/{payload,mapper,output,mode,verdict}.ts` (Claude Code parser reused), output-schema test, fake Codex runner (`testing/fake-codex.ts`: `$SHELL -lc` spawn, the exit-code/JSON/timeout semantics of `pre_tool_use.rs`, concurrent hooks, `should_block`), e2e against `startTestDaemon` | unit + e2e for every verdict and failure path | `adapters/codex/**` |
| 4 | `adapters/opencode` runtime | `jev-cops.ts`, `opencode-types.ts`, `testing/fake-opencode.ts` (sequential hooks, throw semantics, in-place args, `event` fire-and-forget, `session.get/abort` stub), e2e | unit + e2e | `adapters/opencode/**` |
| — | *(session boundary suggested: stop and report)* | | | |
| 5 | Pi parity | §4 changes, `adapters/pi/canary.ts`, fake-Pi runtime module | Pi e2e + canary tests | `adapters/pi/**` |
| 6 | installers | `cops install codex\|opencode` (+ `install pi` version record), `hooks.json` writer, rules emitter, `requirements.toml` fragment, refusals/warnings, canaries, state files | install tests on temp `HOME`/`CODEX_HOME`/`XDG_CONFIG_HOME` | `packages/cli/src/commands/install-{codex,opencode}.ts`, `install-args.ts` (new harness names), `install.ts` dispatch, `adapters/*/src/install*.ts` |
| 7 | doctor | `--harness codex\|opencode` groups, `all` detection, gap lists, live canaries | doctor tests | `packages/cli/src/commands/doctor-{codex,opencode}.ts`, `doctor-run.ts` (two new branches), `doctor.ts` (harness choices) |
| 8 | tamper + replay | T1/T2/T3/T4/T8/T9/T11 rows for both harnesses; `tests/replay/` recorder, `ACCEPTED.md`, `bun run replay:gate` | `bun test tests/tamper`; `bun run replay:gate` | `tests/tamper/*.test.ts` (new `test()`s beside the todos; the OpenShell todos untouched), `tests/replay/**`, `scripts/record-replay.ts`, `package.json` script |
| 9 | live captures + docs | `scripts/live/{fake-responses-api.ts,codex-live.sh,opencode-live.sh,pi-live.sh}`, `docs/captures/{codex,opencode,pi}-m3.md`, `docs/adapters.md#codex/#opencode` (§2 tables + gaps), Pi section update, README/STATUS/DECISIONS | captures reviewed; fixtures from step 1 replaced by captured payloads | `scripts/live/**`, `docs/captures/*-m3.md`, `docs/adapters.md`, `docs/STATUS.md`, `docs/DECISIONS.md` (append), `README.md` |

Steps 0–4 need nothing from M2 or the setup track and can start now; step 0 is a pure move and
should land before M2 step 6 (`cops-hook --url`): if M2 step 6 lands first, step 0 moves its
`client.ts` change along and M2's `INSTALLED_URL` pattern is copied into the OpenCode plugin in
step 4. Step 2's tree rows are one data-only commit rebased after the `config-tamper` fix.
`packages/daemon` is not touched by M3 (the `hold` reason's `cops grant` pointer is text; the
route is M2's). New package manifests (`adapters/codex/package.json`, `adapters/opencode/
package.json`) copy the fields the packaging track defines for `@jev-cops/adapter-claude-code`
(version lockstep, `publishConfig`, `files`, `bin` only for `packages/hook`); the packaging track
owns the root release tooling and the `jev-cops` meta package (its `cops-hook` bin points at
`packages/hook`). The setup track's `skill-install` policy and scanners are untouched; its
`cops setup` can call the three installers once they exist.

### 6.2 Replay corpus (`tests/replay/`)

`scripts/record-replay.ts` starts a real `copsd` (`startTestDaemon`, repo policies, enforce,
judge off, fixed clock) and drives each fake runner through scripted sessions: Pi (6), Claude
Code (6), Codex (5), OpenCode (5): benign `ls`/read; `git push --force origin main` headless;
`rm -rf ./build` rewrite; config write kill + latched prompt; `curl -d @.env` after a secret
read; subagent spawn and a subagent call; `apply_patch` delete (Codex/OpenCode); an interactive
`bash` (hold). It rewrites the temp home and repo to `/home/dev` and `/home/dev/repo` (D-041) and
writes one `<harness>-<n>.jsonl` per root session (≥ 22). `bun run replay:gate` runs `cops
replay --home /home/dev` over each file and fails on any delta absent from
`tests/replay/ACCEPTED.md` (event id pattern, old → new, why). The three live captures' audits
are redacted the same way and added when committed. The M3 review delta (spec gate) is the
`ACCEPTED.md` written in step 8 and re-checked in step 9.

### 6.3 Live captures (gated, never in CI, no real credentials)

One fake **Responses API** (`scripts/live/fake-responses-api.ts`, a Bun server on loopback)
serves all three: it answers `POST /v1/responses` (streaming SSE) with one scripted
`function_call` per `SCENARIO:<name>` in the last user message, then text; it logs every request
(auth header names, never values). Guards from the M1 capture: `env -i`, throw-away homes,
`HTTPS_PROXY`/`HTTP_PROXY` at a logging black-hole proxy with `NO_PROXY=127.0.0.1,localhost`, a
`security` stub first on `PATH`, macOS `sandbox-exec` deny-outbound where the harness tolerates
it, `lsof` sampling; the capture states every refused connection.

- **Codex.** `CODEX_HOME=$TMP/codex` with `config.toml`: `model_provider = "fake"`,
  `[model_providers.fake] name = "fake" base_url = "http://127.0.0.1:<port>/v1" wire_api =
  "responses" env_key = "FAKE_API_KEY"`, `model = "gpt-5.5"`, `check_for_update_on_startup = false`,
  `projects."$TMP/repo".trust_level = "trusted"`; `cops install codex --home $TMP` (honours
  `CODEX_HOME`). Trust: one interactive tmux session runs `/hooks` and trusts the entries (also
  proving the silent skip before it: a `SCENARIO:ls` before trust yields no `judge` line);
  headless scenarios then run `codex exec --json --skip-git-repo-check -C $TMP/repo -s
  workspace-write -a never`. Scenarios: `ls`; `git push --force origin main` (deny, reason as the
  tool result); `rm -rf ./build` (`allow` + `updatedInput` ran the pinned path); `apply_patch`
  adding `~/.codex/hooks.json` (kill: exit 2, latch, next prompt blocked); interactive `bash`
  (hold → deny); `pkill copsd` with the rules file (execpolicy `forbidden` — inside and outside
  the sandbox); a rewritten command that needs escalation (still prompts: `allow` loosens
  nothing); `spawn_agent` + a subagent `Bash` (`agent_id` present); `cat ~/.codex/auth.json` then
  `curl` (secret read → exfil hold). Records the `PostToolUse` `tool_response` shapes into
  `tests/fixtures/codex/`.
- **OpenCode.** `HOME`, `XDG_CONFIG_HOME`, `XDG_DATA_HOME`, `XDG_CACHE_HOME`, `XDG_STATE_HOME`
  under `$TMP`; `OPENCODE_DISABLE_AUTOUPDATE=1`, `OPENCODE_DISABLE_MODELS_FETCH=1`;
  `~/.config/opencode/opencode.json`: `{"provider":{"openai":{"options":{"baseURL":
  "http://127.0.0.1:<port>/v1","apiKey":"dummy"}}},"model":"openai/gpt-5.5"}`; `cops install
  opencode --home $TMP`. Scenarios via `opencode run --format json` and one tmux TUI session: the
  same five plus `task` → subagent `bash` (hook fired under `sess_<child>` with `parent_id`), a
  failing `read` (post event from `event`), `--pure` (no judge line: gap proven), `serve` +
  `run --attach`, `--auto`, and `output.args` replacement vs in-place mutation (row 5).
- **Pi.** Upgrade the local `pi` to 0.99.1 (owner action, §8) or run 0.83.0 as in M0; custom
  provider in `$PI_CODING_AGENT_DIR/models.json` at the fake API (`openai-responses`); the M0
  scenarios plus a nested `codemode` call (`parentToolCallId`), the killed-session prompt abort,
  session start/end reports, and the doctor canary.

## 7. Test list

Runner `bun test`; sibling `*.test.ts` per module; nothing below needs a real harness except the
gated live scripts.

**core** — every new `TOOL_RULES` row normalizes to its kind/paths/hosts (Codex names, OpenCode
names, aliases) · `patch` reader: add/update/delete/move paths, relative resolution, `+` lines in
content taint, malformed patch → `parse-error` opaque exec (fail closed) · `interactive-shell`
verb for `bash`, `sh -l`, `python`, `node`, not for `bash -c …`, `python x.py` · harness flags
and `OPENCODE_*` prefixes → `harness-config` · credential files → secret read · commands-table
rows.

**policies** — config-tree rows (Codex plugins/etc, OpenCode tools and `~/.opencode`) alone and
with the whole set · `opaque-exec@2` holds an interactive shell; `bun run gate` deltas listed.

**packages/hook** — the M1 process/deadline/fail-closed tests moved unchanged; harness dispatch:
`--harness codex` routes to the Codex mapper, an unknown harness fails closed; `--version`.

**adapters/codex unit** — payload fixtures (schemas) parse; `model` → actor; `agent_id` → subagent
ids; output table per verdict × permission mode; every emitted stdout body validates against the
fetched output schema and never contains `continue`, `stopReason`, `ask`; `rewrite` on
`apply_patch` → deny; hold reason carries no raw/summary; fail-open set = `view_image` + inert;
mode from `codex exec` under `sh -lc`; `hooks.json` writer: merge idempotent, foreign groups
byte-identical, quoting refusals, backup; rules emitter output byte-exact and its lists equal to
`judge-guard`'s; `requirements.toml` fragment; refusals for `features.hooks=false`,
`allow_managed_hooks_only`, inline conflicts; trust-state reader for `[hooks.state]` keys.

**adapters/codex e2e (fake Codex + real `copsd`)** — the runner implements `pre_tool_use.rs`:
exit 0 JSON decides, exit 2 + stderr blocks (stdout ignored), exit 2 without stderr / other codes
/ invalid JSON / unsupported fields / timeout → failed and the tool proceeds; hooks from two files
run concurrently and one block wins; `updatedInput` only with `allow` replaces the input;
`UserPromptSubmit` block. Cases: allow · annotate → `additionalContext` · rewrite ran the pinned
command (T9) · hold → deny with the grant pointer · deny · kill → deny + latch + next prompt
blocked (T1) · daemon down: `Bash`/`apply_patch`/MCP blocked, `view_image` proceeds (T2) · 15 s
judge → "judge timeout" under 14 s (T3) · malformed stdin blocked · post event before the next
pre (T10) · first prompt pins, second and subagent do not (T11) · subagent call under
`sess_<sid>.<agent_id>` · `$SHELL` profile printing to stdout is caught by the canary.

**adapters/opencode unit** — event building from `tool.execute.before` input; parent resolution
from cached `session.created` and from `client.session.get`; in-place args mutation (keys
deleted/assigned, object identity kept); throw texts; `after` note append; `event` error part →
post with `ok:false`; `chat.message` first root prompt only; mode from argv; transport functions
byte-identical to Pi's.

**adapters/opencode e2e (fake OpenCode + real `copsd`)** — sequential hooks, throw → tool error
text, in-place args honoured while `output.args = {...}` is ignored, `event` fire-and-forget,
`session.abort` recorded. Cases: allow · annotate on success only · rewrite (T9) · hold → throw ·
deny · kill → throw + abort + latch; next `chat.message` aborts (T1) · daemon down: `bash`,
`edit`, `write`, `webfetch`, `task`, MCP throw; `read`/`glob`/`grep`/`lsp` proceed with a log
line (T2) · 15 s judge → throw "judge timeout" (T3) · subagent session linked with `parent_id`,
its prompt never pins (T11) · failed call observed · a second plugin mutating args after ours is
visible in the post event (documents the gap).

**adapters/pi** — session reports (`start`/`prompt`/`end`), killed prompt → notify + abort,
nested call ids, canary through the installed file; existing 20 e2e cases unchanged.

**install/doctor** — temp homes for `CODEX_HOME`, `XDG_CONFIG_HOME`, `OPENCODE_CONFIG_DIR`,
`PI_CODING_AGENT_DIR`: each installer creates, merges, is idempotent, backs up, uninstalls only
its own; refusals and `--force`; every warning; trust step printed; rules file validated when a
stub `codex` on `PATH` answers `execpolicy check`; state files; canaries pass through real
compiled binaries and fail when the binary is `/bin/true` ("gate silently disabled") or copsd is
down; doctor: green on a healthy setup, one named check per broken condition, gap lines; `all`
detection skips absent harnesses.

**tamper** — T01, T02, T03, T04 (installer + doctor halves), T08, T09, T11 gain `Codex: …` and
`OpenCode: …` tests; the OpenShell todos stay; T04's todo text is updated to name only M2.

**replay** — the recorder produces ≥ 22 files; `replay:gate` passes with an empty `ACCEPTED.md`
before step 1 and with the listed deltas after; a tampered file is a `PROBLEM`.

**live (never in CI)** — the three captures of §6.3 with their safety sections and the facts they
verify (Codex rows 7, 9, 12, 16, 18, 19; OpenCode rows 4, 5, 8, 11, 13).

## 8. Proposed DECISIONS rows (unnumbered; safer option chosen) and owner questions

- **M3-1** Codex uses the shared hook binary with `--harness codex`; the harness-neutral runtime
  moves to `packages/hook` (dispatch by harness, one compiled `cops-hook`); adapters keep
  mapping only. Why: the spec's "reuse the hook binary" and the identical fail-closed shell.
- **M3-2** Codex output never loosens: `allow` is written only as the carrier of `updatedInput`
  (Codex's documented rewrite shape, where "allow" means not blocked and approvals still apply);
  `ask`, `continue`, `stopReason`, `suppressOutput` are never emitted (unsupported fields fail
  the run and let the tool proceed); deny is exit 2 + stderr (+ JSON for parity).
- **M3-3** On Codex and OpenCode `hold` is `deny` (D-008 extended: no hook or plugin can make
  either harness ask); the agent-facing reason names `cops grant <event-id>` (M2's admin route)
  and never the raw command or summary (T8).
- **M3-4** `kill` on Codex/OpenCode = deny + daemon latch (+ `session.abort` on OpenCode); the
  running turn is not ended by the hook; later prompts are blocked (Codex) or aborted (OpenCode).
- **M3-5** `cops install codex` prints the `/hooks` trust step and writes the execpolicy fragment;
  it never writes `[hooks.state]` trust hashes itself (undocumented format; the review is the
  user's); a managed install (`/etc/codex/requirements.toml`, root only, never sudo) is the
  trust-free path and the one used under OpenShell.
- **M3-6** The execpolicy fragment carries only argv-prefix-expressible rules: `forbidden` for the
  judge-guard class, `prompt` for nested harness CLIs and hook-skipping flags; path-based kills
  are recorded as absent (no static prefix), as OpenShell's D-106.
- **M3-7** The OpenCode plugin is one self-contained file (every file in `plugins/` is a plugin);
  its transport is the Pi extension's code, asserted byte-identical by a test; `node:http` over
  the socket (the host may not be Bun).
- **M3-8** OpenCode post events: successes from `tool.execute.after`, failures from the `event`
  hook's error tool parts (best effort, host fire-and-forget); subagent sessions are linked
  through `parentID`; `permission.ask` is not relied on.
- **M3-9** Single-file extensions (Pi, OpenCode) may reach 200 logic lines; adapter packages are
  bound by "no policy logic", not lines. Why: parity items and no helper file allowed.
- **M3-10** Core: `apply_patch` patch reader (Codex `command`, OpenCode `patchText`),
  `interactive-shell` verb held by `opaque-exec@2` (the `write_stdin` gap), Codex/OpenCode tool
  rows and aliases, harness flags and `OPENCODE_*` prefixes as `harness-config`, harness
  credential files as secret reads.
- **M3-11** Config trees: `~/.codex/plugins`, `/etc/codex`, the Windows Codex path, OpenCode
  `tool(s)/` and `~/.opencode` join `config-tamper` (data rows only, rebased after the
  concurrent fix).
- **M3-12** `tests/replay/` holds recorded fake-runner sessions (paths rewritten to the fixture
  home) plus redacted live audits; `bun run replay:gate` fails on any delta not listed in
  `tests/replay/ACCEPTED.md`; this is the spec's "delta reviewed".
- **M3-13** The fake Responses API and the three live scripts are committed under `scripts/live/`
  (no secrets; gated by `JEV_COPS_LIVE_CAPTURE=1`), unlike M1's scratch server, because three
  harnesses share them and the captures must be reproducible.
- **M3-14** Pi parity: `/v1/session` reports, killed-prompt abort, `end` on shutdown, install-time
  `pi --version`, a canary through the installed file; the extension still sends no
  `harness_version` (Pi exposes none) and `user_bash` stays unobserved (deferred).

Owner questions (only what is the owner's):

1. **OpenCode Desktop verification.** The Desktop gap (#38604, closed unresolved) can only be
   confirmed with the Desktop app installed on this machine. Plan prints it as a gap without
   verification; say if you want the app installed for the capture.
2. **Local Pi upgrade.** The Pi capture is most useful on 0.99.1 (`brew upgrade pi`); 0.83.0 is
   what is installed. Upgrade, or capture on 0.83.0 as in M0?
3. **Codex trust UX.** Without a managed `requirements.toml` (root), every user must run `/hooks`
   once per handler change before Codex judges anything. The plan accepts this and prints it;
   if the pilot needs zero-touch installs, the managed path (root-owned `/etc/codex`) is the only
   one, which is an ops decision for the pilot machines.

## 9. Lead amendments (2026-09-30)

1. **§8 question 2 answered (delegated to the lead):** the Pi capture runs on the latest Pi
   (0.99.1) installed into a throwaway prefix under the scratch dir, never through
   `brew upgrade`: the owner's installed `pi` 0.83.0 is left untouched. The adapter is
   re-verified on both 0.83.0 (installed) and 0.99.1 (throwaway).
2. **§8 questions 1 and 3 are the owner's** (installing the OpenCode Desktop app on this
   machine; the Codex trust UX for the pilot). They do not block steps 0–4.
3. **Codex rewrite needs `permissionDecision: "allow"`** as the `updatedInput` carrier. This
   is the one place jev-cops would emit `allow` (D-084 forbids it on Claude Code because it
   skips the approval prompt). Step 3 must verify live, against the fake API, whether a
   Codex `allow` skips Codex's own approval; if it does, rewrite on Codex degrades to
   `deny` with the pinned command in the reason, and the difference goes in adapters.md.
4. **Order.** Step 1 (core) starts now in a worktree; step 0 (`packages/hook` extraction)
   waits for the npm-packaging track to finish touching `adapters/claude-code` and the root
   build scripts; steps 2–4 follow; session boundary before step 5.
