# M1 plan — Claude Code adapter, install, doctor, config-tamper

Source of truth: [SPEC.md](./SPEC.md). M1 definition of done (spec §Milestones):
"Claude Code HTTP and command hooks, hold-to-ask and hold-to-defer mapping,
`cops install claude-code` and `cops doctor` with a canary tool call,
config-tamper policy live." Gate: the M1 subset of `tests/tamper` green.

Docs re-read on 2026-09-29 (ground rule: docs win over the spec). Claude Code is at
**v2.1.285** (`CHANGELOG.md` head). Sources, all fetched as Markdown into
`/private/tmp/claude-501/m1-plan/`: `code.claude.com/docs/en/{hooks,hooks-guide,settings,
settings-reference,permissions,permission-modes,managed-settings,headless,cli-reference,
tools-reference,sub-agents,env-vars}`, the changelog, and issues #18312, #39344, #41791,
#13214 through the GitHub API. Quotes below are verbatim from those pages.

## 1. Definition of done and gate

| Item (spec §Milestones M1) | Planned as |
|---|---|
| Claude Code command hook | `dist/cops-hook` (lean compiled binary) registered in exec form on `PreToolUse`, `PostToolUse`, `PostToolUseFailure`, `UserPromptSubmit`, `ConfigChange`, `SessionStart`, `SessionEnd`; fails closed (§5) |
| Claude Code HTTP hook | `POST /v1/hooks/claude-code` on the daemon's loopback HTTP listener, registered for **post events only** (`--transport http`): the docs make every HTTP failure fail open (§2 row 1) |
| hold → ask | interactive: `permissionDecision: "ask"` with the daemon's normalized raw command and `detail` as `permissionDecisionReason` (T8) |
| hold → defer | **not used**: `defer` is `-p`-only and "ignored with a warning and the tool proceeds" on a multi-call turn (§2 row 6). Headless `hold` stays `deny` (D-008); `dontAsk`/`bypassPermissions` modes also map to `deny` |
| `cops install claude-code` | settings writer: merge, backup, idempotent, refusals, `--managed`, `--uninstall`; also `cops install pi` (wraps M0's `installPiExtension`) |
| `cops doctor` | daemon on both sockets, policies, judge, enforcement, audit chain, effective hooks, binary path, Claude Code version drift, offline canary through the installed binary, optional live canary, every known gap |
| `config-tamper` live | `policies/config-tamper.ts` + fixtures; kill on write/delete under the protected set; ConfigChange hook blocks out-of-band edits and the daemon latches the session killed |

**Gate:** `bun test tests/tamper` with these rows live on Claude Code (fake runner, real
`copsd`): T1 (config-tamper kill + ConfigChange block), T2 (hook fails closed, reads fail
open), T3 (deny "judge timeout" from the hook's own deadline), T4 installer half (refuses or
warns on bare `Bash` allow; the OpenShell half stays `todo` for M2), T8 (ask shows the daemon's
raw + detail, never the agent's `description`), T9 (`updatedInput` carries the pinned paths).
Plus `bun run gate` (6 policies) and a captured real `claude` run in `docs/captures/claude-code-m1.md`.

## 2. Docs-vs-spec differences (Claude Code)

To be copied into `docs/adapters.md#claude-code`. "Spec" is `docs/SPEC.md` (2026-09-29);
"docs" is code.claude.com on 2026-09-29, Claude Code v2.1.285.

| # | Fact | Spec says | Docs say today (source, quote) | Consequence |
|---|---|---|---|---|
| 1 | HTTP hook failure | "Ship as an HTTP hook pointing at `copsd` … plus a fallback command hook" | hooks#http-response-handling: "**Non-2xx status**: non-blocking error, execution continues. **Connection failure**: non-blocking error, execution continues. **Timeout**: the hook is canceled … Unlike command hooks, HTTP hooks can't signal a blocking error through status codes alone." | An HTTP hook can never fail closed. The **command hook is the only PreToolUse transport**; HTTP is offered for post events only (observe class, fail-open allowed by spec §Principles). |
| 2 | Hook timeout | T3: "Adapter returns `deny` … never allow-by-timeout" (assumes the harness timeout is safe) | hooks#timeouts: "A timed-out `command`, `http`, or `mcp_tool` hook doesn't block the tool call. The call continues through the normal permission flow, so don't count on a stalled hook to act as a gate." Default `timeout` "600 for `command`, `http`" | The hook owns its own deadline (13 s = daemon 12 s + 1 s, like Pi) and exits 2 itself; the settings `timeout: 30` is a backstop that must never fire first. |
| 3 | Exit codes | — | hooks#other-exit-codes: "exit code 2 is the only exit code that blocks through the code alone. Without valid JSON on stdout, Claude Code treats exit code 1 as a non-blocking error and proceeds"; "A hook that can't start lands in the same non-blocking bucket … a mistyped path in `settings.json` leaves the gate silently disabled." | Default exit code is 2 from the first line of `main`; only a completed allow/annotate/rewrite path sets 0. Installer verifies the binary path; doctor prints "gate silently disabled" when it is gone. |
| 4 | Deny channel | "map `deny` to `deny` with `permissionDecisionReason`" | hooks#exit-code-2: "exit 2 blocks whether or not you print JSON: even a JSON `permissionDecision` of `"allow"` can't override it. Claude Code still reads any valid JSON output on stdout." permissions#extend-permissions-with-hooks: "A hook that exits with code 2 stops the tool call before permission rules are evaluated, so the block applies even when an allow rule would otherwise let the call proceed." | `deny` = **exit 2 + stderr reason + JSON deny** (both channels); the block is immune to allow rules and to other hooks' `allow`. |
| 5 | `allow` loosens | "map `rewrite` to `allow` plus `updatedInput`; map `annotate` to `allow` plus `additionalContext`" | hooks#pretooluse-decision-control: "`"allow"` skips the permission prompt". Changelog 2.1.222: "Fixed PreToolUse auto-allow hooks bypassing tool restrictions in background agent tasks". Spec: "can only tighten, never loosen". | jev-cops **never emits `permissionDecision: "allow"`**. `allow` = exit 0, no output ("no decision; normal permission flow applies"). `annotate` = `additionalContext` only. `rewrite` = `updatedInput` only, no decision (verify live; fallback `ask` + `updatedInput`, never `allow`). |
| 6 | `defer` | "map `hold` to … `defer` in headless mode"; #41791 "defer is only in the changelog" | #41791 closed 2026-04-28, docs updated. hooks#defer-a-tool-call-for-later: "Claude Code honors this value only in non-interactive mode with the `-p` flag. In interactive sessions it logs a warning and ignores the hook result"; "`"defer"` only works when Claude makes a single tool call in the turn. If Claude makes several tool calls at once, `"defer"` is ignored with a warning and the tool proceeds through the normal permission flow." Precedence "`deny` > `defer` > `ask` > `allow`". | `defer` can silently become allow-by-batch. Not used in M1; D-008 (`hold → deny` headless) stands and the daemon already applies it. |
| 7 | `permissions.allow` bypass (#18312) | "a tool on the `permissions.allow` list has bypassed hook decisions … The installer must refuse to run when `Bash` is on the allow list" | #18312 closed 2026-01-19 as duplicate of #13214 (itself closed as duplicate, no fix note). hooks#permissionrequest: "PreToolUse hooks run before every tool call, whether or not it needs permission." permissions: "To run all Bash commands without prompts except for a few you want blocked, add `"Bash"` to your allow list and register a PreToolUse hook that rejects those specific commands." hooks-guide#hooks-and-permission-modes: "A hook that returns `permissionDecision: "deny"` blocks the tool even in `bypassPermissions` mode". | Exit-2 deny is documented as immune to allow rules; a hook **`ask`** against a bare `Bash` allow is not stated. Installer keeps the spec's refusal for a bare `Bash`/`PowerShell` allow (any scope), `--force` overrides and prints the gap; doctor prints it; the live canary tests it. |
| 8 | Hook `ask` vs `permissions.deny` (#39344) | "a hook `ask` has overridden a `permissions.deny` rule" | Closed 2026-04-18: "This was fixed in **v2.1.101** — A PreToolUse hook returning permissionDecision 'ask' no longer overrides explicit `permissions.deny` rules." hooks: "Deny and ask rules are still evaluated regardless of what the hook returns". Changelog 2.1.77: "Fixed PreToolUse hooks returning `"allow"` bypassing `deny` permission rules". | Gap closed; `doctor` warns only below v2.1.101. |
| 9 | Session termination on `kill` | "Deny plus session terminated" | hooks#json-output: `continue: false` "Claude stops processing entirely after the hook runs. Takes precedence over any event-specific decision fields"; "For `PreToolUse` and `PostToolUse` hooks, the stop applies even when the tool call fails or completes while Claude is still streaming". `stopReason` "stays in the conversation, so Claude sees it". No API ends the process. | `kill` = exit 2 + JSON deny + `continue: false` + `stopReason` (= `reason`, agent-safe). The daemon **latches the session killed** (§4, D-072): every later call is denied, every later prompt is blocked by the UserPromptSubmit hook. |
| 10 | Headless detection | `session.mode` from the harness | Hook input carries `permission_mode` ("`default`, `plan`, `acceptEdits`, `auto`, `dontAsk`, or `bypassPermissions`") but no interactive/print flag. headless: "In a `-p` run with no host, these requests are denied either way"; "`-p` run offers `AskUserQuestion` only when it has a permission host, such as an MCP tool you pass with `--permission-prompt-tool`". | Mode = `headless` iff the parent `claude` argv has `-p`/`--print` and no `--permission-prompt-tool` (Linux `/proc/<ppid>/cmdline`, macOS `ps -o args= -p`, cached per session). A wrong guess only turns `hold` into `ask`, which Claude Code itself denies without a host: never an allow. |
| 11 | Post events | "`PostToolUse`, `PostToolUseFailure`, `PermissionDenied`" | PostToolUseFailure "doesn't fire for tool calls rejected before execution … Permission denials fire `PreToolUse` but not this event". PermissionDenied "only fires in auto mode: it doesn't run when you manually deny a permission dialog, when a `PreToolUse` hook blocks a call, or when a `deny` rule matches." | Post events: `PostToolUse` (ok) and `PostToolUseFailure` (`error` first line "Exit code N"). `PermissionDenied` is not a post-tool event (nothing ran) and is not registered. Denied calls have only a `judge` line, as on Pi. |
| 12 | Task capture | "`session.task` is captured once … from the first user prompt (UserPromptSubmit …) and re-sent on every event" | UserPromptSubmit input: "`prompt` field containing the text the user submitted"; no tool call; "block … erases it from context". | No pre/post phase fits. New agent-surface route `POST /v1/session` (`jev-cops.session/1`) pins the task **before the model sees the prompt** (T11) and returns `{ task, killed }` so the hook can block prompts of a killed session (D-071). |
| 13 | Subagents | "`SubagentStart` parent linking" | hooks#common-input-fields: "When running with `--agent` or inside a subagent, two additional fields are included: `agent_id` … `agent_type`". SubagentStart: "can't block subagent creation"; input has `agent_id`, `agent_type`, no prompt. sub-agents: "a `PreToolUse` hook in `settings.json` also runs before every tool a subagent uses". | Linking is per event: `sess_<session_id>.<agent_id>` with `parent_id = sess_<session_id>`, `actor.kind: "subagent"`. `SubagentStart` is not registered (one fewer spawn; nothing to send). The `Agent` tool's `prompt` is the spawn's task text for the future subagent-spawn policy. |
| 14 | Tool names | `Task`, `MultiEdit`, `BashOutput/KillShell` | tools-reference table: `Agent` (fields `prompt`, `description`, `subagent_type`, `model`), `PowerShell`, `Monitor` (`command` or `ws`), `Glob`, `Grep`, `WebSearch`, `NotebookEdit`, `TaskStop`, `TaskCreate/Get/List/Update`, `TodoWrite` (off by default), `Skill`, `Workflow`, `Artifact`, `SendUserFile`, `PushNotification`, `RemoteTrigger`, `ShareOnboardingGuide`, `SendMessage`, `EnterWorktree`, `LSP`, … No `Task`, no `MultiEdit`, no `BashOutput`. MCP: "`mcp__<server>__<tool>`". | Core `TOOL_RULES` gains the current names (§4, D-074); `Task`/`MultiEdit` stay as aliases. |
| 15 | File paths | — | hooks#pretooluse-input: "For the file tools `Write`, `Edit`, and `Read`, `tool_input.file_path` is always absolute: Claude Code expands `~` and relative paths before hooks run" | Nothing to pin for file tools; T9 rewrites concern Bash. Windows backslash paths are out of scope for M1 (printed gap). |
| 16 | Hooks that never fire | — | hooks#pretooluse: "Files you reference with `@` in your prompt are added without any tool call … no PreToolUse hook fires"; "PreToolUse also doesn't fire for `EndConversation`". headless#bare-mode: `--bare` skips "auto-discovery of hooks". cli-reference `--safe-mode`: "hooks … do not load … Managed settings policy still applies, including policy-configured hooks". hooks#disable-or-remove-hooks: `--settings '{"disableAllHooks": true}'` "takes precedence over project and local settings"; "Only `disableAllHooks` set at the managed settings level can disable managed hooks". `--setting-sources`, `--restricted` ("loads only managed settings and `--settings`"). | Printed by `doctor` and the installer. A **managed** install (`--managed`) survives `--safe-mode`, `--restricted`, `disableAllHooks` outside managed, and `--settings`; `--bare` is unverified for managed hooks (gap). |
| 17 | Workspace trust | — | hooks#workspace-trust: "**Interactive session**: Claude Code holds back hooks from every settings file, including your own `~/.claude/settings.json`, until you accept the workspace trust dialog"; "**`-p` or SDK session**: … treats the folder as trusted, so hooks committed in a repository's `.claude/settings.json` run". | Same shape as Pi's project trust. Doctor reads `projects["<path>"].hasTrustDialogAccepted` in `~/.claude.json` for the cwd and warns. |
| 18 | `allowManagedHooksOnly` / HTTP allowlists | "managed settings for lockdown" | hooks#hook-locations: under `allowManagedHooksOnly` "Your user, project, local, and plugin hooks are blocked"; "`allowedHttpHookUrls`: when defined at any settings level, Claude Code runs an HTTP hook handler only if its URL matches the merged allowlist"; "`httpHookAllowedEnvVars` … interpolates only the environment variables on that list". Changelog 2.1.267: unreadable managed allowlists "admit nothing". | Installer refuses a user/project install under `allowManagedHooksOnly` (unless `--managed`); `--transport http` requires the daemon URL to match `allowedHttpHookUrls` when that key exists. |
| 19 | Managed settings paths | "managed settings for lockdown" | managed-settings: "**macOS**: `/Library/Application Support/ClaudeCode/managed-settings.json` · **Linux and WSL**: `/etc/claude-code/managed-settings.json` · **Windows**: `C:\Program Files\ClaudeCode\managed-settings.json`", plus "an optional `managed-settings.d/` directory"; "Claude Code doesn't read the legacy Windows path `C:\ProgramData\ClaudeCode\managed-settings.json`". Also `~/.claude.json` (global config: trust flags). | These directories join the `config-tamper` protected set; `--managed` writes `managed-settings.d/50-jev-cops.json` when writable, else prints it. |
| 20 | `ConfigChange` | "`ConfigChange` (kill on any change to the hook block)" | hooks#configchange: matchers `user_settings`, `project_settings`, `local_settings`, `policy_settings`, `skills`; input `source`, `file_path`; "Use exit code 2 or a JSON `decision` to prevent the change. When blocked, the new settings are not applied to the running session"; "`policy_settings` changes can't be blocked"; "A blocked change surfaces no message to you or to Claude". Runs "for each settings-file change it detects, not for managed settings that arrive from MDM or the claude.ai console". | The hook blocks every settings change whose file no longer carries an intact jev-cops block or sets `disableAllHooks`; blocks when the daemon is unreachable; reports to `/v1/session` and the daemon latches kill (D-077). `policy_settings`: report only. |
| 21 | Hook environment | — | hooks#common-input-fields: "A hook process inherits the parent environment, apart from the `OTEL_*` exporter variables … and, when `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB` is set to `1`, the variables it strips"; hook JSON must be the only stdout: "If your shell profile prints text on startup, it can interfere with JSON parsing" (shell form only). env-vars: `CLAUDECODE=1`, `CLAUDE_CODE_CHILD_SESSION=1` in hooks. No version variable. | Exec form (`args: [...]`) with the socket path as an argument, never `$JEV_COPS_SOCKET`. `harness_version` comes from `claude --version` recorded by install/doctor (D-076). |
| 22 | Duplicate handlers | — | hooks#hook-handler-fields: "All matching hooks run in parallel. If you define the same handler in more than one settings file, it runs once." hooks-guide: "When multiple `PreToolUse` hooks return `updatedInput` … the last one to finish takes effect." | User + project installs with identical entries do not double-judge; different socket args would. Doctor flags mismatched jev-cops entries and any other rewriting PreToolUse hook. |
| 23 | Precedence with other hooks | — | "When multiple PreToolUse hooks return different decisions, precedence is `deny` > `defer` > `ask` > `allow`." hooks#pretooluse-decision-control: "A hook's `"ask"` also forces a permission prompt in auto mode: the classifier can still deny the tool call, but it can't approve the call silently" (2.1.211+). | Another hook's `allow` cannot undo jev-cops's `deny` or `ask`. `hold → ask` is valid in `auto` mode. |
| 24 | Reason visibility | "`reason` goes back to the agent"; `detail` "never shown to the agent" | `permissionDecisionReason`: "For `"ask"`, shown to the user but not Claude. For `"deny"`, shown to Claude. For `"allow"` and `"defer"`, written to the debug log only". `stopReason` "stays in the conversation, so Claude sees it". | ask → reason may carry `raw` + `detail` (human only, T8). deny/kill → `reason` only; `stopReason` = `reason`. |
| 25 | Protected paths in Claude Code itself | T1 relies on jev-cops | permission-modes#protected-paths: writes to `.git`, `.claude`, … "never auto-approved, except in `bypassPermissions` mode"; changelog 2.1.126: "`--dangerously-skip-permissions` now bypasses prompts for writes to `.claude/`". permission-modes#critical-paths: `rm` of critical paths "no allow rule or `PreToolUse` hook `"allow"` approves". | Claude Code prompts for config writes in normal modes; `config-tamper` is what stops them in `bypassPermissions` (where a hook deny still blocks). |
| 26 | Auto mode is the default | — | permission-modes: "With Claude Code v2.1.283 or later, auto mode is the built-in starting permission mode for interactive terminal and VS Code sessions"; `-p` starts in `default` "when nothing is configured". | Holds land in auto mode's prompt (row 23). `PostToolUse.classifierContext` (feed the classifier jev-cops's risk) is noted for M3+. |

Issue states: #18312 closed 2026-01-19 (duplicate of #13214, closed 2025-12-10 as duplicate);
#39344 closed 2026-04-18 fixed in v2.1.101; #41791 closed 2026-04-28 (docs fixed).
Hook-related changelog since v2.1.89 (≈ six months): 2.1.89 `defer`; 2.1.101 ask-vs-deny fix;
2.1.110 `PermissionRequest` `updatedInput` re-checked against deny rules; 2.1.126 bypass mode
skips protected-path prompts; 2.1.139 exec form `args`, hooks run without terminal access;
2.1.140 spurious `ConfigChange` on symlinked settings fixed; 2.1.211 hook `ask` floors auto
mode at a prompt; 2.1.212 `continue:false` no longer dropped mid-stream; 2.1.214 exit 2 blocks
even with invalid JSON; 2.1.222 auto-allow hooks in background tasks fixed; 2.1.248 invalid
`{…}` stdout is a reported error, `--restricted`; 2.1.259 `--permission-prompts none`;
2.1.267 unreadable managed HTTP allowlists admit nothing; 2.1.268 `PermissionRequest` fires
in `--print`; 2.1.285 sync hooks no longer hang on a backgrounded child.

## 3. Build order with gates

| # | Module | Delivers | Gate |
|---|---|---|---|
| 1 | `packages/core` normalizer + context | Claude Code tool names and shapes in `TOOL_RULES`/`TOOL_ALIASES` (§4.1); inert tools; `run_in_background` verb; harness CLIs as `spawn`; Edit `new_string`, NotebookEdit `new_source` in the content-taint extractor; `ctx.config.home` + `ctx.config.protectedPaths` on `PolicyContext` | core tests; new rows in `tests/fixtures/commands/commands.json` |
| 2 | `policies/config-tamper.ts` + fixtures | spec row "any write under the four harness config dirs or `policies/` → kill" with the precise set (§4.5) | `bun run gate` (6 policies) |
| 3 | `packages/daemon` | `POST /v1/session` (`jev-cops.session/1`), kill latch + `sessionKilled` mapping, `POST /v1/hooks/claude-code` (post events over HTTP, shares the adapter mapper) | daemon tests; T1/T11 daemon-side |
| 4 | `adapters/claude-code` hook runtime | payload parser → canonical mapper → verdict → hook output; socket client with deadlines; fail-closed shell; mode detection; `dist/cops-hook` | unit + fake-runner e2e for every verdict and failure; compiled-binary latency test |
| 5 | adapter events | PostToolUse/PostToolUseFailure observe (bounded head, hash, awaited ≤ 2 s); UserPromptSubmit task once; ConfigChange block + report; SessionStart (model, mode cache) / SessionEnd (best-effort close) | fake-runner e2e: T10 taint through post, T11 first prompt, T1 ConfigChange |
| — | *(session boundary suggested: stop and report)* | | |
| 6 | settings writer + `cops install claude-code` / `install pi` | merge, backup, idempotent, refusals, `--managed`, `--uninstall`, `--dry-run`, gaps printed | install tests on temp `HOME`/cwd |
| 7 | `cops doctor` + canary | checks (§4.4), offline canary through the registered binary, `--live` canary | doctor tests with `startTestDaemon` + temp settings |
| 8 | `tests/tamper` | T1, T2, T3, T4 (installer), T8, T9 live on Claude Code | `bun test tests/tamper` |
| 9 | docs | `adapters.md#claude-code` (table of §2 + gaps), adapter README, STATUS, DECISIONS D-065…, `docs/captures/claude-code-m1.md` from a real `claude` run (deny, rewrite, hold-ask) | captured run reviewed |

Steps 1–3 can proceed while the concurrent daemon work (explain access, score stripping,
`env.git` derivation) lands; the adapter only needs `/v1/judge`, `/v1/observe`, the
`hold_token` of D-059, and one "T8 view" call that returns `{ raw, detail }` for a pending hold
given its token (whatever route that work names; the hook presents the token it just received
and never persists it). The adapter sends no `env.git` (like Pi, D-058).

## 4. Module map and interfaces

### 4.1 Core changes (`packages/core`)

```ts
// normalizer/normalize.ts — additions to TOOL_RULES (D-074)
Agent:        { reader: "spawn" }                               // was Task; Task stays
Monitor:      { reader: "bash" }                                // input.command; `ws` → net rule below
PowerShell:   { reader: "shell" }                               // opaque interpreter exec
Glob:         { reader: "path", fields: ["path"], kind: "fs.read", access: "read" }
Grep:         { reader: "path", fields: ["path"], kind: "fs.read", access: "read" }
NotebookEdit: { ...WRITE_RULE, fields: ["notebook_path", "file_path"] }
WebSearch:    { reader: "kind", kind: "net" }                   // no host; query is not a URL
Artifact | SendUserFile | PushNotification | RemoteTrigger | ShareOnboardingGuide:
              { reader: "kind", kind: "net" }                   // data leaves the machine
Workflow | CronCreate: { reader: "spawn" }
TaskCreate | TaskGet | TaskList | TaskUpdate | TodoWrite | TaskOutput | TaskStop | ToolSearch |
WaitForMcpServers | ListAgents | ListMcpResourcesTool | ReadMcpResourceTool | AskUserQuestion |
EnterPlanMode | ExitPlanMode | ScheduleWakeup | ReportFindings | SubagentHandback | LSP |
SendMessage | EnterWorktree | ExitWorktree | Skill | SendFeedback:
              { reader: "inert" }                               // kind other, verbs ["inert"]: reversibility 0, scope expected
// new ToolRule variants
| { reader: "kind"; kind: CallKind }     // fixed kind, no fields read
| { reader: "inert" }                    // no side effect; the floor treats it as a read
// TOOL_ALIASES: Agent → Task (scope's expected-tools table keeps "Task"), MultiEdit → Edit
// canonicalTool(): "mcp__<server>__<tool>" → "mcp:<server>:<tool>" (spec form), kind other
// classify.ts: input.run_in_background === true adds verb "background"; argv[0] ∈ claude|codex|opencode|pi → kind spawn
// context/taint.ts: content fields scanned for taint: Write.content, Edit.new_string, NotebookEdit.new_source (+ Pi's edits[].newText)
// policy/context.ts: ctx.config: { home: string; protectedPaths: readonly string[] }  // from daemon config
```

Why `inert`: `other` is "scored like exec" (spec), so `TaskCreate` every few calls would
annotate constantly. Bookkeeping tools have no side effect; classification stays in core (D-054).

### 4.2 Adapter (`adapters/claude-code`, package `@jev-cops/adapter-claude-code`)

```text
src/
  payload.ts    stdin JSON → HookInput (discriminated on hook_event_name); never throws
  mapper.ts     HookInput + Context → PreEvent | PostEvent (canonical, verbatim tool_input)
  output.ts     Judged + HookInput + Mode → HookOutput { exitCode, stdout, stderr }   (pure, D-065)
  client.ts     Unix-socket JSON client (Bun fetch({ unix })), deadlines 13 s judge / 2 s other
  mode.ts       headless detection from the parent claude argv; per-session cache (D-068)
  hook.ts       runHook(): fail-closed shell, event dispatch, local log            (≤ 150 lines with mapper+output)
  settings.ts   settings files: read (strict JSON), merge/strip jev-cops entries, effective view, paths per OS
  install.ts    installClaudeCodeHooks(), uninstall, CLAUDE_CODE_GAPS
  doctor.ts     checks for `cops doctor --harness claude-code`
  canary.ts     offline + live canary
  hook-main.ts  entry for `bun build --compile` → dist/cops-hook (imports nothing from @jev-cops/core)
testing/fake-claude-code.ts   runner with the documented exit-code/JSON/timeout/precedence semantics
README.md
```

```ts
// payload.ts — the documented input shapes (hooks#common-input-fields and per event)
interface CommonInput { session_id: string; transcript_path?: string; cwd: string; permission_mode?: PermissionMode;
  hook_event_name: HookEventName; prompt_id?: string; agent_id?: string; agent_type?: string; scratchpad_dir?: string }
type PermissionMode = "default" | "plan" | "acceptEdits" | "auto" | "dontAsk" | "bypassPermissions";
type HookInput =
  | (CommonInput & { hook_event_name: "PreToolUse"; tool_name: string; tool_input: Record<string, unknown>; tool_use_id: string; mcp_server?: { name: string; source: string } })
  | (CommonInput & { hook_event_name: "PostToolUse"; tool_name: string; tool_input: Record<string, unknown>; tool_use_id: string; tool_response: unknown; duration_ms?: number })
  | (CommonInput & { hook_event_name: "PostToolUseFailure"; tool_name: string; tool_input: Record<string, unknown>; tool_use_id: string; error: string; is_interrupt?: boolean; duration_ms?: number })
  | (CommonInput & { hook_event_name: "UserPromptSubmit"; prompt: string })
  | (CommonInput & { hook_event_name: "ConfigChange"; source: "user_settings" | "project_settings" | "local_settings" | "policy_settings" | "skills"; file_path?: string })
  | (CommonInput & { hook_event_name: "SessionStart"; source: "startup" | "resume" | "clear" | "compact" | "fork"; model?: string })
  | (CommonInput & { hook_event_name: "SessionEnd"; reason: string });
function parseHookInput(text: string): Result<HookInput, string>;      // unknown event names are an error

// mapper.ts
interface Context { harnessVersion: string | null; mode: SessionMode; model: string | null; now: () => number }
function sessionOf(i: CommonInput, ctx: Context): Session;             // sess_<session_id>[.<agent_id>], parent_id, mode (D-070)
function kindOf(tool: string): CallKind;                                // best effort; daemon reclassifies (D-013)
function toPreEvent(i: PreToolUseInput, ctx: Context): PreEvent;        // call.id = call_<tool_use_id>, tool = canonical name, input verbatim
function toPostEvent(i: PostToolUseInput | PostToolUseFailureInput, ctx: Context): PostEvent;
function resultOf(i): CallResult;  // ok, exit_code (0 on success for shells; "Exit code N" first line on failure), stdout_sha256, stdout_head ≤ 4096 chars, bytes_out
// text for hashing: Bash/PowerShell/Monitor → stdout + "\n" + stderr; Read → file.content; Agent → content[].text; string → itself; else canonical JSON

// output.ts (D-065, D-068)
interface HookOutput { exitCode: 0 | 2; stdout: string | null; stderr: string | null }
function toHookOutput(v: Judged, i: PreToolUseInput, mode: SessionMode, t8: { raw: string; detail: string | null } | null): HookOutput;
//  allow    → { 0, null, null }
//  annotate → { 0, {hookSpecificOutput:{hookEventName:"PreToolUse", additionalContext: note}}, null }
//  rewrite  → { 0, {hookSpecificOutput:{hookEventName:"PreToolUse", updatedInput}}, null }           // no permissionDecision
//  hold     → interactive & mode ∉ {dontAsk,bypassPermissions}:
//               { 0, {hookSpecificOutput:{…, permissionDecision:"ask", permissionDecisionReason: `${reason}\n\n${raw}\n\n${detail}`}}, null }
//             else deny with reason (D-008 extended)
//  deny     → { 2, {hookSpecificOutput:{…, permissionDecision:"deny", permissionDecisionReason: reason}}, `jev-cops: ${reason}` }
//  kill     → { 2, {continue:false, stopReason:`jev-cops: ${reason}`, hookSpecificOutput:{…deny…}}, `jev-cops: ${reason}` }
function unavailable(i: PreToolUseInput, cause: string): HookOutput;   // exec/write/delete/net/spawn/other → exit 2 "judge unreachable (…); blocking (fail closed)"; read/inert → exit 0 + stderr + local log

// client.ts
interface Client { judge(e: PreEvent): Promise<Reply>; observe(e: PostEvent): Promise<Reply>;
  session(s: SessionReport): Promise<Reply>; t8View(eventId: string, holdToken: string): Promise<{ raw: string; detail: string | null } | null> }
function createClient(socket: string, deadlines?: { judgeMs?: number; shortMs?: number }): Client;   // 13_000 / 2_000

// hook.ts
function runHook(argv: readonly string[], stdin: string, env: Env, io: Io): Promise<0 | 2>;
// process.exitCode = 2 before anything else; uncaughtException/unhandledRejection → write reason, exit 2;
// per event: PreToolUse → judge → output; PostToolUse* → observe (await ≤ 2 s, never blocks: exit 0);
// UserPromptSubmit → session("prompt") → block if killed (decision:"block"), else exit 0;
// ConfigChange → intact? → session("config-change") → exit 2 unless intact && ok; SessionStart/End → session(...) best effort, exit 0
```

### 4.3 CLI (`packages/cli/src/commands/{hook,install,doctor}.ts`)

```text
cops hook --harness claude-code [--socket path]          stdin → stdout/exit (delegates to adapter runHook)
cops install claude-code [--user|--project|--local|--managed] [--socket path] [--transport command|http]
                            [--hook-binary path] [--force] [--dry-run] [--uninstall]
cops install pi [--global] [--socket path]                wraps installPiExtension (M0)
cops doctor [--harness claude-code|pi|all] [--live] [--json] [--socket path] [--admin-socket path]
```

```ts
// install.ts
interface InstallOptions { scope: "user" | "project" | "local" | "managed"; projectDir?: string; home?: string; socket?: string;
  transport: "command" | "http"; hookBinary?: string; force?: boolean; dryRun?: boolean; env?: Env; print?: (l: string) => void }
interface InstallResult { path: string; backup: string | null; changed: boolean; refused: string[]; warnings: string[]; gaps: readonly string[] }
function installClaudeCodeHooks(o: InstallOptions): InstallResult;     // throws only on unwritable target or invalid existing JSON
function uninstallClaudeCodeHooks(o: Pick<InstallOptions, "scope" | "projectDir" | "home">): InstallResult;
function jevCopsHookEntries(hookBinary: string, socket: string, transport, httpUrl?: string): Record<HookEventName, HookGroup[]>;
//  PreToolUse:  [{ hooks: [{ type:"command", command: hookBinary, args:["--harness","claude-code","--socket",socket], timeout: 30 }] }]   (no matcher = all tools)
//  PostToolUse / PostToolUseFailure: same, timeout 15  (or { type:"http", url: `${httpUrl}/v1/hooks/claude-code`, timeout: 15 } with --transport http)
//  UserPromptSubmit / ConfigChange / SessionStart / SessionEnd: command, timeout 10 (SessionEnd shares the 1.5 s budget: best effort)
function isJevCopsHandler(h: unknown, hookBinary?: string): boolean;   // identity = command basename `cops-hook`|`jev-cops` + args include "claude-code"
function mergeHooks(existing: Settings, entries): Settings;            // append our groups, drop stale jev-cops groups first; nothing else touched
function refusals(effective: EffectiveSettings, o: InstallOptions): string[];
//  bare `Bash`/`PowerShell` in permissions.allow at any scope (spec) · disableAllHooks true in the effective non-managed view when scope ≠ managed
//  · allowManagedHooksOnly true when scope ≠ managed · --transport http without a matching allowedHttpHookUrls entry or without daemon.http
//  warnings (never refuse): permissions.defaultMode bypassPermissions/dontAsk (holds become denies) · folder not trusted (interactive hooks held back)

// settings.ts
interface SettingsPaths { user: string; project: string; local: string; managed: string[]; globalConfig: string }   // per OS (§2 row 19)
function settingsPaths(home: string, projectDir: string, platform: NodeJS.Platform): SettingsPaths;
function readSettingsFile(path: string): Result<Settings, string>;     // strict JSON; missing file = {}
function effectiveSettings(paths: SettingsPaths): EffectiveSettings;   // per-file view + merged hooks/permissions (arrays concatenate)
function writeSettingsFile(path: string, s: Settings, backup: boolean): { backup: string | null };   // 0600 for local/user, atomic rename

// doctor.ts
interface Check { name: string; status: "ok" | "warn" | "fail" | "gap"; detail: string }
function claudeCodeChecks(o: { paths: SettingsPaths; state: AdapterState | null; claudeVersion: string | null; daemonHealth: Health | null }): Check[];
```

### 4.4 `cops doctor` checks

Daemon: `/v1/health` on the agent socket and on the admin socket (version, policies + degraded
flags, judge name, enforcement; `warn` when `observe`: "no verdict is enforced"); audit chain
verifies (`readAudit` + the daemon's chain verifier, L6 caveat printed). Claude Code: `claude`
on PATH and its version vs the recorded one (docs verified at 2.1.285; `warn` on drift, `fail`
below 2.1.101); effective settings: jev-cops entries present on every event above, in exec form,
binary path exists and is executable, `cops-hook --version` matches, socket arg matches the
daemon's socket, no mismatched duplicates, no other `PreToolUse` hook that could rewrite input;
`disableAllHooks`, `allowManagedHooksOnly`, bare `Bash`/`PowerShell` allow, `defaultMode`,
`allowedHttpHookUrls`, workspace trust for the cwd; state file `~/.jev-cops/claude-code.json`
readable; local hook log size. Then every string of `CLAUDE_CODE_GAPS` and `PI_GAPS`.

**Canary.** A live model is not deterministic, so the default canary is offline and exercises
the real path: doctor spawns the binary **exactly as the effective settings register it**
(command + args, exec form) and feeds two synthetic `PreToolUse` payloads with a throw-away
session id: (a) `Write` to `~/.claude/settings.json` → expects exit 2, stdout JSON with
`permissionDecision: "deny"` and `continue: false` (proves: binary runs, daemon reached,
`config-tamper` loaded, kill mapped; in `observe` mode this yields exit 0 and doctor reports
"enforcement observe: the hook cannot block, by design"); (b) `Bash` `true` → expects exit 0
and empty stdout. `--live` (needs `claude` on PATH and `JEV_COPS_LIVE_CANARY=1`; never in CI)
runs `claude -p --permission-mode dontAsk --max-turns 2 --output-format json --allowedTools
"Bash(printf *)" "Run exactly this shell command and nothing else: printf jev-cops-canary-<nonce>"`,
then looks for a `judge` line with the nonce under the run's `session_id`, and with
`--allowedTools Bash` also proves the allow-list case (§2 row 7).

### 4.5 `config-tamper` policy (`policies/config-tamper.ts`)

```ts
// protected set (absolute, home from ctx.config.home, extra from ctx.config.protectedPaths = [policy] protected_paths)
Claude Code: ~/.claude/, ~/.claude.json, <repo|cwd>/.claude/, /Library/Application Support/ClaudeCode/, /etc/claude-code/, C:\Program Files\ClaudeCode\
Codex:       ~/.codex/, <repo|cwd>/.codex/
OpenCode:    ~/.config/opencode/, <repo|cwd>/.opencode/, <repo|cwd>/opencode.json, opencode.jsonc
Pi:          ~/.pi/agent/, <repo|cwd>/.pi/
jev-cops:     policies dir, ~/.config/jev-cops/, <repo|cwd>/.cops.toml, ~/.jev-cops/ (sockets, audit, store, state), the hook and daemon binaries (`protected_paths` from `cops install`'s printed line)
when:   some path in e.fs.access with access ≠ "read" is under the set (write, delete, exec, unknown: mv/cp/ln/chmod/git checkout -- … count)
        || an opaque span or interpreter payload mentions a protected path (string match on e.raw after ~ expansion)
        || a harness CLI mutates config: claude config|mcp|plugin|auto-mode reset, codex …, opencode …, pi … (argv)
decide: write/delete/exec/unknown access → "kill"; mention or CLI → "hold"
range: ["hold", "kill"]; reads never match; precedents never bypass kill (D-035)
reason: "Writing to <path> would change the harness or judge configuration."
```

Fixtures (≥ 12): Write to `<repo>/.claude/settings.json` → kill; Edit `~/.claude/settings.json`
→ kill; Bash `echo … > ~/.claude/settings.json` → kill; `rm -rf ~/.pi/agent/extensions` → kill;
`cp x ~/.codex/hooks.json` → kill; `mv ~/.claude/settings.json /tmp/` → kill (delete side);
`git checkout -- .claude/settings.json` → kill; `python -c "open('~/.claude/settings.json','w')"`
→ hold; `claude config set …` → hold; `cat ~/.claude/settings.json` → no match; Read of
`.claude/settings.json` → no match; write to `<repo>/src/config.ts` → no match; write under
`~/.jev-cops/` → kill; write to `policies/x.ts` → kill.

### 4.6 Daemon changes (`packages/daemon`)

```ts
// routes.ts (agent surface): POST /v1/session, POST /v1/hooks/claude-code
// schema jev-cops.session/1 (D-071)
interface SessionReport { schema: "jev-cops.session/1"; harness: Harness; harness_version?: string;
  session: { id: string; parent_id: string | null; mode?: SessionMode; started_at?: string };
  kind: "start" | "prompt" | "end" | "config-change";
  prompt?: string;                       // kind prompt: task, set once (T11), truncated at 16 KB
  model?: string; source?: string;       // kind start
  file_path?: string; intact?: boolean; config_source?: string }   // kind config-change
// reply { ok: true, task: string | null, killed: boolean }; audit line kind "session"
// sessions.ts: markKilled(root) / isKilled(root); killed on any `kill` verdict and on config-change { intact:false } (D-072)
// service.ts handleJudge: if sessions.isKilled(root) → verdict kill, reason "session terminated by jev-cops", mapping ["sessionKilled"], no engine run
// /v1/hooks/claude-code: body = raw Claude Code payload (PostToolUse | PostToolUseFailure only) → adapter mapper → handleObserve → 200 {}   (D-066)
//   PreToolUse over HTTP is refused with 400 "PreToolUse must use the command hook (fails open over HTTP)"
// config.ts: [policy] protected_paths = [] (extra), passed to ctx.config with daemon.home
```

## 5. Fail-closed analysis (Claude Code)

| # | Path where a tool could run unjudged | Closed by | Residual |
|---|---|---|---|
| 1 | Hook binary missing, not executable, path mistyped → "non-blocking … the action proceeds" | Installer verifies the path and runs the offline canary; doctor re-verifies and prints "gate silently disabled" | Cannot be closed from the hook. `SessionStart` on the same binary shows an error to the user in interactive sessions only. **Gap printed.** |
| 2 | Hook exits 0/1/other without a decision (crash, unhandled rejection, JSON write failure) | `process.exitCode = 2` before any work; `uncaughtException`/`unhandledRejection` handlers write the reason and exit 2; stdout is written before the code is lowered to 0 | SIGKILL/OOM of the hook → proceeds. Printed; OpenShell backstop (M2). |
| 3 | Claude Code cancels the hook at `timeout` → proceeds | Internal deadline 13 s < settings `timeout: 30`; deadline exits 2 "judge timeout" (T3) | A machine that cannot start the binary within 30 s. Printed. |
| 4 | Daemon down, socket refused, non-200, 504, invalid reply, wrong `event_id` | exit 2 "judge unreachable (…); blocking (fail closed)" for exec/write/delete/net/spawn/other; read/inert tools exit 0 with a stderr warning and a line in `~/.jev-cops/claude-code-hook.log` (T2 observe class, D-055 parity) | — |
| 5 | Malformed stdin / unknown event / missing `tool_name` | Tool events: exit 2 "unreadable hook payload"; ConfigChange: exit 2; UserPromptSubmit/SessionStart/End: exit 0 with a warning (nothing to protect; task stays unknown) | — |
| 6 | HTTP transport: connection failure, non-2xx, timeout → proceeds | HTTP is post-only (observe class); the daemon refuses PreToolUse over HTTP | — |
| 7 | Settings edited mid-session to remove the hook or set `disableAllHooks` | ConfigChange hook blocks unless the jev-cops block is intact; blocks when the daemon is unreachable; daemon latches kill | `policy_settings` cannot be blocked (root-owned files). Printed. |
| 8 | Another PreToolUse hook returns `allow`; another hook's `updatedInput` | Precedence deny > ask > allow; our deny is exit 2 | A second rewriting hook races ours ("last one to finish"). Doctor flags it. |
| 9 | Bare `Bash`/`PowerShell` in `permissions.allow` | Docs: exit-2 deny "applies even when an allow rule would otherwise let the call proceed"; installer refuses unless `--force`; live canary checks | Hook `ask` vs allow rule undocumented. Printed. |
| 10 | `dontAsk` / `bypassPermissions` | deny still blocks (docs); `hold` mapped to `deny` in these modes | — |
| 11 | Headless `-p` | Daemon maps `hold → deny` (D-008); a wrong mode guess yields `ask`, which Claude Code denies without a permission host | — |
| 12 | `defer` | Never emitted | — |
| 13 | `kill` does not end the process | `continue: false` ends the turn; daemon latch denies every later call and the UserPromptSubmit hook blocks later prompts (`killed: true`) | `--fork-session` or a fresh session is a new root (not latched). A nested `claude` started through Bash is judged as its own root session. Printed. |
| 14 | `--bare`, `--safe-mode`, `--setting-sources`, `--settings '{"disableAllHooks":true}'`, `--restricted`, untrusted folder (interactive), `allowManagedHooksOnly`, cloud sessions, `@`-file reads, `EndConversation`, `!` user commands, VS Code/desktop surfaces not verified | Managed install closes `--safe-mode`, `--restricted`, `--settings` and non-managed `disableAllHooks`; nothing closes the rest | **Gaps printed** (`CLAUDE_CODE_GAPS`). |
| 15 | Sockets reachable by the agent without OpenShell (self-posted judge, self-resolve) | Same as Pi: hold token; no precedents on Claude Code in M1 (D-069) | Printed; M2. |
| 16 | `Read` deny-rule paths: `@` references, `grep -r` without a path | Not tool calls / normalizer limits | Printed. |

## 6. Test list

Runner `bun test`; every module has a sibling `*.test.ts`; fixtures under
`tests/fixtures/claude-code/` are the documented payloads (one JSON per event, copied from the
hooks reference examples, plus a subagent PreToolUse with `agent_id`, an MCP tool with
`mcp_server`, a Windows `Write` path kept as a negative case).

**core** — every new `TOOL_RULES` row normalizes to its kind/paths/hosts · `Agent` is `spawn`
with `prompt` untouched in `raw` · `Monitor` `command` parsed as bash, `ws` → net · `WebSearch`
→ net, no host · inert tools: kind other, reversibility 0, scope not "unexpected" · `mcp__s__t`
→ `mcp:s:t` other · `run_in_background` adds verb `background` · `claude -p …` → spawn ·
`Edit.new_string` and `NotebookEdit.new_source` tainted when they carry a tainted string ·
`ctx.config.protectedPaths` and `home` reach a policy.

**policies/config-tamper** — the fixture list of §4.5, alone and with the whole set;
precedent never lowers kill; observe mode maps kill to allow with the "would have" note.

**daemon** — `/v1/session` prompt sets the task once and a second prompt is ignored (T11) ·
truncation at 16 KB · `start`/`end` audited · `config-change { intact:false }` latches kill ·
a kill verdict latches; the next `/v1/judge` answers kill with `mapping: ["sessionKilled"]`
without running the engine · `/v1/hooks/claude-code` accepts PostToolUse and
PostToolUseFailure, refuses PreToolUse with 400, 404 on the admin socket · schema errors 400.

**adapter unit** — `parseHookInput` accepts every fixture, rejects an unknown event and a
non-object · `sessionOf`: root vs subagent ids, parent, actor kind · `toPreEvent` keeps
`tool_input` by reference-equal content · `resultOf`: Bash text = stdout+stderr, sha256,
head 4096, bytes; failure exit code from "Exit code N"; interrupt → ok false · `toHookOutput`:
one case per verdict × mode (`default`, `auto`, `plan`, `acceptEdits`, `dontAsk`,
`bypassPermissions`) × interactive/headless; never a `permissionDecision: "allow"`; deny and
kill exit 2 with JSON; `stopReason` never contains `detail`; ask reason contains `raw` and
`detail` and not `tool_input.description` (T8) · `unavailable`: fail closed per kind, fail
open for read/inert · `mode.ts`: `-p` → headless, `-p --permission-prompt-tool x` →
interactive, no `-p` → interactive; cache hit/miss · settings: `settingsPaths` per platform ·
`readSettingsFile` rejects comments/trailing commas · `mergeHooks` appends, is idempotent,
replaces stale jev-cops groups, leaves foreign hooks byte-identical · `refusals` for each rule ·
`writeSettingsFile` backs up and writes atomically · `uninstall` removes only jev-cops entries.

**adapter e2e (fake Claude Code runner + real `copsd` on a temp socket)** — the runner
implements the docs exactly: exit 2 blocks (reason = JSON `permissionDecisionReason` if
present else stderr) and still parses JSON; exit 0 + JSON decides; other exit + valid JSON
decides; other exit + invalid/none proceeds and records a hook error; `timeout` cancels and
proceeds; precedence deny > defer > ask > allow across handlers; `ask` in headless without a
host → denied, with a host → host callback; `defer` ignored (warning) in interactive and in a
multi-call batch; `updatedInput` replaces the input and permission rules run on the new input;
`continue:false` ends the turn; HTTP 2xx JSON / 2xx empty / non-2xx / connection failure /
timeout; ConfigChange block keeps the old settings except `policy_settings`; UserPromptSubmit
block erases the prompt; PostToolUse runs synchronously before the next model call.
Cases: allow runs unchanged · annotate → `additionalContext` next to the result · rewrite →
runner ran the pinned input (T9) · hold interactive → ask with raw + detail (T8) · hold headless
→ deny (D-008) · hold in `dontAsk`/`bypassPermissions` → deny · deny → blocked, model sees
`reason` only · kill → blocked + turn ended + next call denied by the latch + next prompt
blocked (T1) · daemon stopped → exec/write/other blocked, `Read`/`Grep` proceed with a log
line (T2) · 15 s judge → blocked "judge timeout" in < 1 s past the deadline (T3) · malformed
stdin → blocked · post event registers taint before the next pre event (T10) · first prompt
is the task, second is ignored (T11) · subagent call shares the parent's case file · ConfigChange
with an intact block → allowed; hook block removed → blocked + latched (T1) · `policy_settings`
→ reported, not blocked · HTTP transport: post events recorded; PreToolUse refused · observe
mode: kill becomes allow with the "would have" note.

**compiled binary** — `bun run build` then `dist/cops-hook` on a synthetic PreToolUse with
the daemon answering allow: exit 0, empty stdout, p50 wall time under 150 ms over 20 runs;
`dist/cops hook --harness claude-code` gives the same output; `dist/cops install
claude-code --dry-run` and `dist/cops doctor` run from the binary (D-053 rule).

**install/doctor** — temp `HOME` and project: user install creates `~/.claude/settings.json`
when absent; merges into an existing file with foreign hooks; second run is a no-op and
prints "already installed"; backup file written on change; `--project`/`--local`/`--managed`
targets; `--managed` prints the JSON when the directory is unwritable; refusals: bare `Bash`
allow (each scope), `disableAllHooks`, `allowManagedHooksOnly`, `--transport http` without
allowlist; `--force` proceeds and prints the gap; `--uninstall` restores foreign hooks
byte-identical; `install pi` delegates; gaps printed. Doctor: every check green on a healthy
setup; each broken condition yields its named `fail`/`warn`/`gap`; offline canary passes
through a real compiled binary and fails when the binary is replaced by `/bin/true`
("gate silently disabled") or the daemon is stopped; `--live` is skipped without
`JEV_COPS_LIVE_CANARY=1` and reported as skipped.

**tamper** — T01, T02, T03, T04 (installer half), T08, T09 gain `Claude Code: …` tests named
with the spec's required outcome; their `test.todo` bodies are replaced, never deleted.

**live (never in CI)** — `docs/captures/claude-code-m1.md`: a real `claude` (2.1.285) run in
`enforce` mode showing a deny (`git push --force origin main` headless), a rewrite (`rm -rf
./build` pinned), an interactive hold prompt with the jev-cops reason, and a `config-tamper`
kill; and the verification of §2 row 5 (rewrite without a decision) and row 10 (VS Code /
SDK argv).

## 7. Proposed DECISIONS rows (safer option chosen; reverse by editing code and the table)

- **D-065** Claude Code output mapping never loosens: `allow` = exit 0 with no output;
  `annotate` = `additionalContext` only; `rewrite` = `updatedInput` only (normal permission
  flow on the pinned input; fallback `ask` + `updatedInput`, never `allow`); `deny` = exit 2 +
  stderr + JSON deny; `kill` = deny + `continue:false` + `stopReason` (= `reason`, never
  `detail`). Why: `"allow"` "skips the permission prompt" (§2 row 5); spec: tighten only.
- **D-066** The command hook is the only PreToolUse transport; the HTTP hook
  (`/v1/hooks/claude-code`) serves post events only and needs `daemon.http` plus a matching
  `allowedHttpHookUrls` entry when that key exists. Why: every HTTP failure fails open (§2 row 1).
- **D-067** Hook fail-closed rules: default exit code 2 from the first line; any throw,
  rejection, parse failure, unreachable daemon, non-200, 504, invalid reply, wrong `event_id`
  or the 13 s deadline exits 2 with the reason; read/inert tools fail open with a stderr
  warning and a local log line; the settings `timeout: 30` is a backstop never relied on.
- **D-068** `hold` → `ask` (reason = verdict reason + normalized raw + `detail`, human-only)
  in interactive sessions in modes `default`/`plan`/`acceptEdits`/`auto`; → `deny` when the
  parent `claude` runs with `-p` and no `--permission-prompt-tool`, or in `dontAsk`/
  `bypassPermissions`. `defer` unused. Why: a pause the harness cannot honour must not become
  an allow (D-008); `defer` is ignored on multi-call turns.
- **D-069** No precedents from Claude Code holds in M1: the hook discards `hold_token` and the
  hold expires unresolved. Why: the hook runs inside the sandbox as the agent, so nothing it
  persists is hidden from the agent, and the human answers Claude Code's own prompt, invisible
  to jev-cops. Cost: the repeat-hold surcharge (D-023/D-034) applies to re-asked actions; reset
  through the admin socket. Alternative for M2: resolve-on-execution when OpenShell keeps tool
  processes off the socket.
- **D-070** Session ids: root `sess_<session_id>`; a call carrying `agent_id` is
  `sess_<session_id>.<agent_id>` with `parent_id` = root and `actor.kind: "subagent"`;
  `SubagentStart` is not registered; `actor.model` comes from the `SessionStart` payload via
  the per-session state file (informational, best effort).
- **D-071** New agent-surface route `POST /v1/session` (`jev-cops.session/1`, kinds `start`,
  `prompt`, `end`, `config-change`) sets the task once from the first `UserPromptSubmit`
  before the model runs (T11; 16 KB cap) and answers `{ task, killed }`; the hook blocks the
  prompt of a killed session. Why: the canonical schema has no phase for a prompt; a state
  file the agent can edit is not a safe carrier.
- **D-072** Kill latch: after a `kill` verdict, or a `config-change` report with the hook
  block not intact, the root session is killed and every later `/v1/judge` answers `kill`
  (`mapping: ["sessionKilled"]`) without running the engine; cleared only by session GC.
  Why: spec "session terminated"; Claude Code offers no process kill from a hook.
- **D-073** `config-tamper` protected set and verdicts as in §4.5; reads never match; extra
  paths from `[policy] protected_paths`; the installer prints the line to add for the binaries.
- **D-074** Core tool table for Claude Code names (§4.1), `inert` reader, `run_in_background`
  verb, harness CLIs as `spawn`, Edit/NotebookEdit content fields in taint. Why: D-054
  (adapters stay policy-free); `other` scored like exec would annotate bookkeeping tools.
- **D-075** Installer: user scope by default; merge, backup, atomic write, idempotent by handler
  identity (binary basename + `claude-code` arg); refuses on bare `Bash`/`PowerShell` allow,
  `disableAllHooks`, `allowManagedHooksOnly` (non-managed scope), unmatched HTTP allowlist;
  `--force` proceeds and prints the gap; `--dangerously-skip-permissions` printed as out of
  scope (OpenShell); `--managed` writes `managed-settings.d/50-jev-cops.json` or prints it.
- **D-076** `harness_version` is `claude --version` recorded by install/doctor in
  `~/.jev-cops/claude-code.json`; the hook sends it, omits it when unknown; doctor warns on
  drift from the verified 2.1.285 and fails below 2.1.101 (#39344).
- **D-077** ConfigChange hook: blocks (exit 2) unless the changed file still carries the intact
  jev-cops block and does not set `disableAllHooks`; blocks when the daemon is unreachable;
  reports every change to `/v1/session`; `policy_settings` is report-only (cannot be blocked).
- **D-078** Doctor canary: offline through the registered binary with the documented payloads
  (config write → exit 2 + `continue:false`; `Bash true` → exit 0); `--live` only with `claude`
  on PATH and `JEV_COPS_LIVE_CANARY=1`, never in CI.
- **D-079** `dist/cops-hook` is a separate lean binary (no `@jev-cops/core`, no WASM) and
  `cops hook` shares its module; the hook's p50 overhead on the compiled binary is a test.

## 8. Open question for the owner

1. **Headless `hold`, revisited with the docs.** D-008 chose `deny`. The docs now document
   `defer` but add that it "only works when Claude makes a single tool call in the turn" and
   is otherwise "ignored with a warning and the tool proceeds through the normal permission
   flow" (hooks#defer-a-tool-call-for-later), so a `defer` can silently become an allow. The
   plan keeps `deny` everywhere and does not implement `defer`. Confirm, or ask for an opt-in
   `--headless-hold defer` for Agent SDK hosts that guarantee single-call turns (M3 at the
   earliest, never the default).

Everything else in this plan is a proposed DECISIONS row (§7), chosen as the safer option.

**Owner answer (2026-09-29):** delegated to the lead's judgement — headless `hold` stays
`deny` everywhere (D-008); `defer` is never emitted. No opt-in in M1.

## 9. Review amendments (lead, 2026-09-29)

1. **`config-tamper` is tiered, not a blanket kill on every harness directory.** Claude Code's
   own model legitimately writes under `~/.claude/` through ordinary tools (auto-memory in
   `~/.claude/projects/*/memory/`, plan files in `~/.claude/plans/`, todos); killing those would
   end ordinary sessions. Tiers, all absolute after `~` expansion:
   - **kill** — files that control hooks, permissions or extensions: `settings.json`,
     `settings.local.json`, `~/.claude.json`, managed-settings dirs, `hooks/`, `plugins/`;
     `~/.codex/{config.toml,hooks.json}` and `.codex/`; OpenCode `plugin/` dirs and
     `opencode.json[c]`; Pi `extensions/` dirs and `settings.json`; jev-cops config,
     `.cops.toml`, the policies dir, `~/.jev-cops/`, the hook/daemon binaries.
   - **hold** — instruction persistence: `CLAUDE.md`/`AGENTS.md` under harness config dirs
     (`~/.claude/CLAUDE.md`, `~/.codex/AGENTS.md`), `skills/`, `agents/`, `commands/`,
     `output-styles/`, and any other path under a protected harness directory not listed in
     a tier.
   - **annotate** — harness-managed data the model writes by design: `~/.claude/projects/*/memory/**`,
     `~/.claude/plans/**`, `~/.claude/todos/**`.
   - Reads never match. Opaque mention of a kill-tier path or a config-mutating harness CLI
     → `hold` (unchanged).
   `range` becomes `["annotate", "kill"]`. Fixtures add: memory write → annotate; plan write →
   annotate; `~/.claude/skills/x/SKILL.md` write → hold; `~/.claude/settings.json` Edit → kill.
2. **Build order unchanged.** Steps 1–5 first, then stop and report, then 6–9.
3. **Decision numbering.** The pre-M1 hardening landed first as D-065–D-070, so the §7
   proposals are recorded from D-071 on, in the order they land. D-068 (main/master always
   default) is implemented in step 1 alongside the core changes.

