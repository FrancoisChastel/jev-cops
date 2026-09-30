# Adapter notes

Per harness: what the official docs say today, where they differ from `SPEC.md`
(dated 2026-09-29), and the gaps `cops doctor` must print. Each section is filled
in when that adapter is built, after re-reading the current docs. Docs win over the
spec; every difference is listed here.

## Pi

Built in M0 step 10 (`adapters/pi`). Verified on 2026-09-29 against the **Pi v0.87.1** source
(tag released 2026-09-22; the spec cites v0.85.1). Files read:
`packages/coding-agent/docs/{extensions,configuration}.md`,
`src/core/extensions/{types,runner}.ts`, `src/core/agent-session.ts`
(`_installAgentToolHooks`, `bindExtensions`), `src/modes/print-mode.ts`,
`src/core/session-manager.ts`, and `src/core/tools/{bash,powershell,read,write,edit,grep,find,ls}.ts`.
Real runs used the locally installed Pi **0.83.0**; see
[`captures/pi-m0.md`](./captures/pi-m0.md).

### Entry and locations

- The entry point is `export default function (pi: ExtensionAPI) { … }`, sync or async.
  Pi loads it with jiti, so there is no build step. Its `engines` field requires
  **Node ≥ 22.19**: the extension runs on Node, not Bun, so it talks to the socket with
  `node:http` (`socketPath`) rather than Bun's `fetch({ unix })`.
- Pi loads direct `.ts`/`.js` files and subdirectories that contain an `index.ts` from:
  - `~/.pi/agent/extensions/`, or `$PI_CODING_AGENT_DIR/extensions/` (user);
  - `<cwd>/.pi/extensions/` (project; it loads **only after project trust** is granted);
  - `pi -e <path>` (explicit; still loads under `--no-extensions`).
- The installed extension is one file. `pi-types.ts` is imported with `import type` only,
  and jiti erases that import. Verified on 0.83.0: a type-only import of a missing file
  loads, while a runtime import of a missing file fails with "Cannot find module".

### Event contract (v0.87.1, as used)

| Pi event | Payload used | Result used |
|---|---|---|
| `session_start` | `reason: "startup" \| "reload" \| "new" \| "resume" \| "fork"` | none. `new`/`fork` reset the cached task; `reload` keeps everything. |
| `before_agent_start` | `prompt` (raw user prompt after expansion) | none. The first prompt of the session becomes `session.task` (T11). |
| `tool_call` | `toolCallId`, `toolName`, `input` (mutable) | `{ block?, reason?, terminate? }`. Handlers run in order; the first `block` wins. |
| `tool_result` | `toolCallId`, `toolName`, `input`, `content[]`, `isError`, `details` | `{ content? }`. Handlers compose, each seeing the previous content. A throwing handler is reported and skipped. |

`ctx` fields used: `hasUI` (true in `tui` and `rpc`), `cwd`, `sessionManager.getSessionId()`
(a uuidv7), `model?.id`, `ui.confirm(title, message)`, `ui.notify(message, type)`,
`abort()`, and `shutdown()`.

Canonical event built by the adapter:

- `id`: `evt_` + ULID, minted inline.
- `harness`: `"pi"`. No `harness_version` is sent: Pi exposes none to extensions.
- `session`: `{ id: "sess_" + getSessionId(), parent_id: null, task, mode: hasUI ? "interactive" : "headless", started_at }`.
- `actor`: `{ kind: "agent", model: ctx.model.id }`.
- `call`: `{ id: "call_" + toolCallId, tool: toolName, kind, input, cwd: ctx.cwd }`. The
  `input` is sent verbatim.
- `env`: `{ sandbox: { kind: "none" } }`. No `env.git`: copsd derives it from `cwd`
  (see the gap list below).

Post events add `result`: `{ ok: !isError, stdout_sha256, stdout_head (first 4096 chars), bytes_out }`,
computed over the text blocks of `content`. Tool call ids from OpenAI-style providers are
long and contain `|`, `/`, `+` and `=`. They are valid `call_` ids (no whitespace).

Built-in tools, whose input schemas are in `src/core/tools/*.ts`. The adapter's `kind`
table is best-effort; the daemon's normalizer rules live in core `TOOL_RULES`:

| Tool | Input | Adapter `kind` | Normalizer |
|---|---|---|---|
| `bash` | `{ command, timeout? }` | `exec` | parsed as bash |
| `powershell` | `{ command, timeout? }` (same schema as bash) | `exec` | opaque `interpreter` exec: the bash grammar cannot read PowerShell |
| `read` | `{ path, offset?, limit? }` | `fs.read` | path `path` |
| `write` | `{ path, content }` | `fs.write` | path `path`; `content` hashed and taint-checked |
| `edit` | `{ path, edits: [{ oldText, newText }] }` | `fs.write` | path `path`; each `newText` taint-checked |
| `grep` | `{ pattern, path?, glob?, … }` | `fs.read` | path `path` (the pattern is not a path) |
| `find` | `{ pattern, path?, limit? }` | `fs.read` | path `path` |
| `ls` | `{ path?, limit? }` | `fs.read` | path `path` |
| anything else | verbatim | `other` | `other` (scored like exec) |

`canonicalTool()` maps these names onto the names the context engine's tables use
(`bash`/`powershell` → `Bash`, `read` → `Read`, `write` → `Write`, `edit` → `Edit`,
`grep` → `Grep`, `find`/`ls` → `Glob`), so a Pi `bash` call counts as Bash for scope and
for content taint.

### Verdict mapping

| Verdict | Pi |
|---|---|
| allow | nothing returned |
| annotate | the tool runs; `context_note` is appended to the tool result as a `[jev-cops] …` text block in `tool_result`. A note from any verdict is appended, including observe mode's "would have". |
| rewrite | `event.input` is replaced in place: keys missing from `updated_input` are deleted, the rest assigned. Nothing is returned. |
| hold | interactive: `GET /v1/explain/<id>` with `Authorization: Bearer <hold_token>`, which on the agent socket returns only the confirm view `{ event_id, verdict, reason, raw, detail }` of a pending hold, then `ctx.ui.confirm("jev-cops hold: <reason>", "<normalized raw>\n\n<detail>")`. Yes posts `/v1/resolve` `allow`, `by: "pi-user"` with the verdict's `hold_token`, and the tool runs. No posts `deny` (with the token) and blocks. The token stays in the extension: the model only ever sees `reason`, and the daemon refuses a view or a resolve without it (403 and an `anomaly` line). When the verdict carries no token or the view cannot be loaded, the call is blocked without asking. Headless: blocked (the daemon already sends `deny`, D-008, and mints no token). |
| deny | `{ block: true, reason: "jev-cops: <reason>" }` |
| kill | `{ block: true, reason, terminate: true }` plus `ctx.abort()` and `ctx.shutdown()` |

Failures. A transport error, a non-200 reply, an invalid reply, or a verdict whose
`event_id` is not the event's all block the call with `jev-cops: judge unreachable (…);
blocking (fail closed)`. A 504 or a client timeout (13 s = the daemon's 12 s deadline + 1 s)
blocks it with `jev-cops: judge timeout; …` (T3). The exception is `fs.read` tools, which
continue and warn through `ui.notify` or stderr (T2, observe-only). Known failures return
an explicit block rather than throwing, so the reason reaches the model verbatim. An
unexpected exception still throws, and Pi blocks on a throwing `tool_call` handler.
`/v1/observe` is awaited for at most 2 s, so a result's taint is registered before the
model reads it; a failure only warns.

### Differences from the spec (Pi row and "Pi adapter" paragraph)

1. **No `updatedInput`.** A rewrite mutates `event.input` in place (the spec row already
   says so). There is no return field for it, and Pi does not re-validate the input after
   mutation.
2. **`terminate` is a batch-level hint.** Early termination happens only when every
   finalized tool result in the batch sets it. `kill` therefore also calls `ctx.abort()`.
3. **No sequential preflight.** The spec says sibling calls are "preflighted sequentially
   then run concurrently". The v0.87.1 docs say only: "Tool calls from one assistant
   message can run in parallel. Do not assume a sibling call or result exists when
   another tool event runs." All blocking state must be committed inside `tool_call`,
   which it is: `/v1/judge` records the pre event before answering.
4. **A throwing `tool_call` handler blocks the tool** as a fail-safe. `agent-session.ts`
   rethrows the error, and the docs say "A `tool_call` handler failure blocks the tool".
5. **No additional-context field on `tool_call`.** `annotate` notes are appended to the
   result content in `tool_result`, whose handlers may replace `content`.
6. **No subagent signal.** `ToolCallEventBase` at v0.87.1 has only `type` and `toolCallId`,
   with no `parentToolCallId`. Pi has no built-in subagent tool, so every call is sent as
   `actor.kind: "agent"`, `parent_id: null`. Agents that other extensions nest are not
   linked.
7. **Headless is detected by `ctx.hasUI`.** It is false in print and json modes; `rpc`
   counts as interactive (its client may forward dialogs).
8. **Project extensions need trust.** The spec's `.pi/extensions/` is confirmed, but it
   loads only after project trust.
9. **Pi 0.87 adds a `powershell` tool.** It is sent as `exec` and normalized as opaque.
10. **The adapter uses `tool_result`, not `tool_execution_end`.** Only `tool_result` can
    change the content the model sees.
11. **No `tool_result` for blocked calls** (observed on 0.83.0), so a denied call has only
    a `judge` audit line.
12. **Pi's own event stream shows the pre-rewrite arguments.** `tool_execution_start` is
    observed on 0.83.0 with the model's original args, while the tool runs the rewritten
    input. The jev-cops audit log has both: the `judge` line has the original, the
    `observe` line the pinned input.
13. **`ctx.shutdown()` is a no-op in print and json modes.** No shutdown handler is bound
    in `print-mode.ts`, so `ctx.abort()` is what ends a headless run.
14. **The extension runs on Node, inside Pi's own process.** This is not the spec's
    compiled Bun hook binary, so no extra runtime is needed.

### Gaps `cops doctor` must print (M1)

These are the `PI_GAPS` strings in `adapters/pi/install.ts`, which the installer already
prints:

- **Without OpenShell, every deny is best-effort.** The agent can edit or delete the
  extension file (T1, T4).
- **`pi --no-extensions` / `-ne` starts Pi without jev-cops.** Only an explicit `-e` still
  loads.
- **Project installs are inactive until the project is trusted.**
- **Denied calls produce no post event.**
- **`kill` relies on `ctx.abort()` in headless runs.** `terminate` is a batch hint, and
  `shutdown` is a no-op in print and json modes.
- **No `env.git` from the adapter; copsd derives it.** The adapter stays
  dependency-free and never shells out to git. For an event without `env.git` (or
  without `repo`/`branch`) the daemon derives, outside the sandbox and from `call.cwd`:
  the repo root, the branch (none when detached), the default branch from `origin/HEAD`
  and dirty, plus the origin host for scope. Git runs with argv arrays, a scrubbed
  environment and fsmonitor, hooks, pager and every transport switched off, within
  `daemon.git_probe_timeout_ms` (300 ms), cached per cwd for 5 s; dirty is computed from
  index stat data so no filter driver can run. What the daemon filled in is on the audit
  line as `derived.git`, and `cops explain` shows it. The values still come from a
  repository the agent can write, so it can steer them (move `origin/HEAD` so `main`
  stops counting as the default branch, `git init` a parent directory); what cannot be
  derived stays unknown and counts as exposure (D-024).
- **Read-only tools fail open when the daemon is unreachable.** They are logged only to
  the Pi notification or stderr; there is no local log file.
- **Other extensions' tools are opaque.** They are sent as `other`, and their nested
  agents are not linked as subagent sessions.
- **User-typed commands are not judged.** Commands the user types with `!` (`user_bash`)
  bypass `tool_call`.
- **Without OpenShell, the sockets are reachable by the agent.** The agent runs as you, so
  it can connect to `copsd.sock` itself. The hold token stops it from approving, or
  reading the confirm view of, a hold the extension received (it never sees the verdict
  response), but it can post judge requests of its own and resolve or view those.
  `copsd-admin.sock` (budget reset, full explain) is human-only only when it is not
  mounted into the sandbox.

### Sockets

The extension talks to the agent socket only (`~/.jev-cops/copsd.sock`, or the path the
installer baked in). `copsd` also listens on an admin socket
(`~/.jev-cops/copsd-admin.sock`, `daemon.admin_socket`) that serves `/v1/budget/reset`,
`/v1/health` and the full `/v1/explain/<id>` (the audit line with trace, features and
evidence); the agent socket answers `/v1/budget/reset` with 404, and serves
`/v1/explain/<id>` only as the confirm view of a pending hold to a caller presenting its
token as a Bearer header (403 and an `anomaly` line without it, 404 once the hold is
resolved or expired). Loopback HTTP, when enabled, is an agent channel with the same
rules. On agent channels a verdict also carries no scores: `features: {}`, `jev: []`,
`risk` to one decimal (the audit line keeps the exact values).
Never mount the admin socket into a sandbox: `cops budget <session> --reset` is how a
human resets a budget.

## Claude Code

Built in M1 steps 4–5 (`adapters/claude-code`, `cops hook`, `dist/cops-hook`).
Verified on 2026-09-29 against the Claude Code docs for **v2.1.285**
(`code.claude.com/docs/en/{hooks,hooks-guide,settings,permissions,permission-modes,managed-settings,headless,cli-reference,tools-reference,sub-agents,env-vars}`,
re-fetched for this step and unchanged since the M1 plan) and against a real **claude
2.1.280** whose model calls were scripted by a local fake Anthropic Messages API (Claude
Code, its hook runner and the hook were real; see [Verified live](#verified-live)).
`install claude-code`, `doctor` and a captured real-model run are M1 steps 6–9.

### Entry and registration

The hook is a command hook in exec form (`args`, no shell), registered on `PreToolUse`,
`PostToolUse`, `PostToolUseFailure`, `UserPromptSubmit`, `ConfigChange`, `SessionStart`
and `SessionEnd`, with no matcher:

```json
{ "type": "command", "command": "/abs/path/dist/cops-hook",
  "args": ["--harness", "claude-code", "--socket", "/home/you/.jev-cops/copsd.sock"],
  "timeout": 30 }
```

- `dist/cops-hook` (`bun run build:hook`) is a separate lean binary: 124 modules, no
  tree-sitter, no WASM; `cops hook --harness claude-code` runs the same code from the full
  CLI. `--harness pi` is refused (Pi runs an extension).
- The socket is an argument (default `~/.jev-cops/copsd.sock`), never an environment
  variable. `JEV_COPS_HOOK_DEADLINE_MS` can only lower the hook's deadlines (drills, tests).
- Timeouts registered by the installer (step 6): `PreToolUse` 30 s, post events 15 s, the
  others 10 s. The hook's own deadlines are 13 s for `PreToolUse` (the daemon's 12 s + 1 s)
  and 5 s for the rest, 2 s per short request, so Claude Code's timeout, which lets the call
  proceed, never fires first.
- Cold start of the compiled binary on a benign call (daemon answering allow, macOS arm64):
  0.54 s for the first exec of a fresh binary, 43 ms p50 over 10 runs.

### Event contract (as used)

| Event | Route | Input used | Outcome |
|---|---|---|---|
| `PreToolUse` | `POST /v1/judge` (+ `GET /v1/explain/:id` for a hold) | `session_id`, `agent_id`, `cwd`, `permission_mode`, `tool_name`, `tool_input`, `tool_use_id` | the verdict mapping below |
| `PostToolUse`, `PostToolUseFailure` | `POST /v1/observe`, awaited ≤ 2 s | + `tool_response` / `error`, `is_interrupt` | exit 0 always; a failure is logged |
| `UserPromptSubmit` | `POST /v1/session` `prompt` | `prompt` | blocked (`decision: "block"` + exit 2) when the reply says `killed: true`; the first prompt pins the task (T11) |
| `SessionStart` | `POST /v1/session` `start` | `source`, `model` | exit 0; `systemMessage` warns the user when the daemon is down or the session is latched |
| `SessionEnd` | `POST /v1/session` `end` | `reason` | exit 0, best effort |
| `ConfigChange` | `POST /v1/session` `config-change` | `source`, `file_path` | blocked unless the cops hook is [intact](#intact) and the daemon was told; `policy_settings` report only |

Every report carries the session mode, the cwd and the permission mode (a mode that is not
an identifier is reported as `unknown`, which the daemon reads as "no human", D-078).
Unknown payload keys (`transcript_path`, `prompt_id`, `effort`, `scratchpad_dir`,
`mcp_server`, `duration_ms`, …) are dropped; a payload missing a field jev-cops reads is
refused (see failure handling).

Canonical event built by the hook:

- `id`: `evt_` + ULID. `harness`: `"claude-code"`. `harness_version`: the `claude_version`
  recorded in `~/.jev-cops/claude-code.json` by install/doctor, omitted until then.
- `session`: `{ id: "sess_" + session_id, parent_id: null, mode }`, or for a call carrying
  `agent_id`, `{ id: "sess_<session_id>.<agent_id>", parent_id: "sess_<session_id>" }` with
  `actor.kind: "subagent"` (D-075). No `task` (the daemon pins it from the first prompt).
- `call`: `{ id: "call_" + tool_use_id, tool: tool_name, kind, input: tool_input, cwd }`,
  the input verbatim and by reference; the kind is best effort (the daemon reclassifies).
- No `env`: the daemon derives `env.git` from `cwd` (D-067); a missing sandbox counts as none.
- Post events go through the daemon's own mapper (`@jev-cops/daemon/claude-code/post`, D-080),
  the one shared with `POST /v1/hooks/claude-code`.
- `mode`: `headless` when the parent `claude` runs with `-p`/`--print` (or a short-flag
  cluster with `p`) and no `--permission-prompt-tool` (or with `--permission-prompts none`);
  in shell form up to three shells (`sh`, `bash`, `zsh`, `cmd`, `pwsh`, …) are unwrapped.
  `/proc` on Linux, `ps` elsewhere, per call (a few ms). A parent that cannot be read, or
  is not recognizably Claude Code (`claude`, `claude.exe`, or an interpreter running a
  `claude-code` package), counts as headless.

### Verdict mapping

| Verdict | Claude Code hook output |
|---|---|
| allow | exit 0, no output: no decision, the normal permission flow applies (never `permissionDecision: "allow"`, which skips the prompt) |
| annotate | exit 0, `hookSpecificOutput.additionalContext` = `jev-cops: <note>`; a note on any verdict (observe mode's "would have") is sent the same way |
| rewrite | exit 0, `hookSpecificOutput.updatedInput` = the daemon's `updated_input`, no decision: Claude Code runs the pinned input and applies its permission rules to it (verified live); a rewrite without its input is blocked |
| hold | a human can answer (interactive session; permission mode `default`, `plan`, `acceptEdits`, `auto` or absent): exit 0, `permissionDecision: "ask"`, `permissionDecisionReason` = `jev-cops hold: <reason>`, the daemon's normalized raw command, its `detail` and a `cops explain <event-id>` pointer, read from `GET /v1/explain/:id` with the view-only token of the `x-jev-cops-view-token` response header (D-079). No token or no view: blocked without asking. No human (headless, `dontAsk`, `bypassPermissions`, an unknown mode): deny with the reason |
| deny | exit 2 + stderr `jev-cops: <reason>` + JSON `permissionDecision: "deny"` with the same reason (what Claude sees) |
| kill | deny + `continue: false` + `stopReason` (= the reason, never the detail); the daemon latches the session, so every later call is `kill` and every later prompt is blocked |

`defer` is never emitted (D-070). Who sees what: `permissionDecisionReason` of a deny and a
`stopReason` reach Claude; of an `ask`, only the user in an interactive session; exit-0
stderr goes to the debug log only; `systemMessage` goes to the user.

### Failure handling

The hook sets exit code 2 before doing anything else; `hook-main.ts` imports the runtime
dynamically after that line, so even a module that fails to load blocks. Uncaught
exceptions and unhandled rejections exit 2 with the reason (Bun would exit 1, which Claude
Code treats as "proceed"). Output is written with synchronous writes (an async write is cut
at the pipe's 64 KB by `process.exit`), then the process exits with the outcome's code.

| Failure (PLAN-M1 §5) | Outcome |
|---|---|
| Daemon unreachable, non-200, invalid reply, another event's verdict (row 4) | exit 2 `jev-cops: judge unreachable (…); blocking (fail closed)`; `Read`, `Glob`, `Grep` and core's inert tools exit 0 with `systemMessage` + stderr `…; read-only <tool> allowed (fail open)` and a line in `~/.jev-cops/claude-code-hook.log` (D-055 parity) |
| 504, or the hook's own deadline (rows 3–4, T3) | the same with `judge timeout` |
| Crash, rejection, stdin that never closes, bad arguments (row 2) | exit 2 with the reason |
| Unreadable payload, unknown event, missing field (row 5) | `PreToolUse`, `ConfigChange`, no event name: exit 2 `unreadable hook payload (…)`; `UserPromptSubmit`, `SessionStart`, `SessionEnd`, post events: exit 0 with a warning |
| Post event not recorded | exit 0, stderr + log line (never blocks; the tool already ran) |
| Prompt not recorded | exit 0 with `systemMessage`: the task stays unknown until a later prompt is recorded; tool calls still fail closed |
| Settings change with the daemon unreachable (row 7) | blocked (exit 2 + `decision: "block"`) |
| Settings change not intact (row 7) | blocked and reported `intact: false`: the daemon latches the session (D-077) |

<a id="intact"></a>
### "Intact" (ConfigChange)

After the change, for each of `PreToolUse`, `PostToolUse`, `PostToolUseFailure`,
`UserPromptSubmit` and `ConfigChange`, some settings file Claude Code loads (user, or
`$CLAUDE_CONFIG_DIR`; project and local under `$CLAUDE_PROJECT_DIR` or the cwd; managed
`managed-settings.json` and `managed-settings.d/*.json`; plus the changed file) registers,
in a group whose matcher selects every call (absent, `""` or `"*"`; `UserPromptSubmit` has
no matcher), a handler that is this very hook: `type: "command"` in exec form, `command`
resolving (after `${CLAUDE_PROJECT_DIR}`, `PATH` and symlinks) to the running executable,
the same leading arguments (the script under `bun`, `hook` under the CLI), `--harness
claude-code`, the same socket, no `if`, not `async`/`asyncRewake`, and a `timeout` absent
or at least 14 s (`PreToolUse`) or 6 s (the rest), so the hook's own deadline comes first.
An HTTP post handler (`--transport http`, step 6) does not count: the hook cannot tell the
daemon's loopback port from a decoy's, so such a change could blind the taint feed while
looking intact (found in review); step 6 has to hand the daemon's URL to the hook first.
And nothing switches it off: `disableAllHooks` in any file
disables a non-managed install, `allowManagedHooksOnly` in managed settings does too, and
managed `disableAllHooks` disables everything. A changed file that is not valid JSON is not
intact. The check is over the files as they are on disk, so a change to project settings
does not end a session whose hook lives in user settings (the plan's "the changed file must
still carry the block" would have).

### Differences from the spec

From PLAN-M1 §2 (docs of 2026-09-29, Claude Code v2.1.285; "spec" is `docs/SPEC.md`). Rows
27–33 were found while building and verifying the hook.

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
| 27 | `updatedInput` without a decision | "map `rewrite` to `allow` plus `updatedInput`" | hooks#pretooluse-decision-control only says "Combine with `"allow"` to auto-approve, or `"ask"` to show the modified input to the user"; changelog 2.1.0 "Fixed PreToolUse hooks to allow `updatedInput` when returning `ask`" | Verified live (2.1.280): `updatedInput` alone replaces the input (the rewritten command ran) and permission checks apply to the new input. `rewrite` = `updatedInput` only; the plan's `ask` fallback is not needed. |
| 28 | An `ask` without a human | Plan §2 row 10: "A wrong guess only turns `hold` into `ask`, which Claude Code itself denies without a host" | `permissionDecisionReason`: "For `"ask"`, shown to the user but not Claude" | Observed on 2.1.280: in `-p` with no permission host the ask is denied **and its reason becomes the tool result Claude reads**. An ask would leak the daemon's `detail` to the model, so the hook asks only when a human can answer, and a parent that is unreadable or not recognizably `claude` counts as headless (gap printed for launchers that hide `-p`). |
| 29 | Exit 2 + JSON deny + `continue: false` | "Deny plus session terminated" | hooks#exit-code-2, #json-output | Verified live: blocked, Claude sees the JSON `permissionDecisionReason`, no further model call (`terminal_reason: "hook_stopped"`). |
| 30 | Prompt block | — | UserPromptSubmit: `decision: "block"` "prevents the prompt from being processed and erases it from context"; `reason` "Shown to the user … Not added to context"; exit 2 "routes the same way" | Verified live: exit 2 + JSON block → no model call; the user sees `UserPromptSubmit operation blocked by hook: <reason>`. |
| 31 | Exec form parent | — | hooks#exec-form-and-shell-form: "spawned directly with `args`" | Verified live: the hook's parent is `claude` itself (`ps` shows `claude -p …`), so the argv heuristic of row 10 reads one process. |
| 32 | ConfigChange feedback | "`ConfigChange` (kill on any change to the hook block)" | "A blocked change surfaces no message to you or to Claude"; `reason` "Accepted but never shown" | The block is silent; the daemon's latch and its `anomaly` line are how the change shows. "Intact" is checked over every settings file (see above), not the changed file alone. |
| 33 | Event timeouts | — | `UserPromptSubmit` default 30 s; `SessionEnd` shares a 1.5 s budget raised by a per-hook `timeout` up to 60 s; a timed-out `UserPromptSubmit` hook's output is discarded | The hook's non-`PreToolUse` deadline is 5 s (reports 2 s); `SessionEnd` is best effort. |

### Verified live

Claude Code **2.1.280** (the docs are at 2.1.285), `claude -p` with `--settings` pointing at a
temp settings file, `HOME`/`CLAUDE_CONFIG_DIR` in a temp directory, and
`ANTHROPIC_BASE_URL` at a local fake Messages API that answers the first turn with one
`Bash` `tool_use` (`echo ORIGINAL`) and the next with text. A probe hook (a shell script)
returned fixed outputs; the transcript and the fake API's second request show what ran and
what Claude read:

| Hook output | Observed |
|---|---|
| exit 0, `updatedInput: {command: "echo REWRITTEN"}`, no decision | the tool ran `echo REWRITTEN` (tool result `REWRITTEN`) |
| same, `updatedInput` → `rm -f …` outside the allow rule | refused by Claude Code's own checks on the rewritten input |
| exit 2, JSON deny + `continue: false` + stderr | Claude's tool result is the JSON reason; the run stopped (`hook_stopped`) |
| exit 0, `ask` (`-p`, no host) | denied; Claude's tool result is the ask's reason |
| exit 0, `additionalContext` | a `hook_additional_context` attachment next to the tool result |
| `UserPromptSubmit`: exit 2 + `decision: "block"` | no model request; the result names the JSON reason |

Not verified live (needs an interactive TTY or a real model; M1 step 9 captures them): the
interactive `ask` dialog text and its rendering of newlines, `auto` mode's classifier after a
hook `ask` (what Claude reads if the classifier denies), `ConfigChange` firing on a real
settings edit, SDK / VS Code argv (row 10), and `stopReason` display.

### Gaps `cops doctor` must print (M1)

These are the `CLAUDE_CODE_GAPS` strings in `adapters/claude-code/src/gaps.ts`; install
(step 6) and doctor (step 7) print them:

- **A hook that cannot start is a non-blocking error.** A missing, non-executable or
  mistyped binary lets every call through; doctor checks the path and runs a canary.
- **A hook killed by the OS, or not started within 30 s, lets the call proceed.** Only
  OpenShell (M2) backstops it.
- **No OpenShell: every deny is best-effort.** `config-tamper` and the ConfigChange hook stop
  the changes Claude Code sees; the files stay writable by the agent (T1, T4).
- **`policy_settings` changes cannot be blocked.** They are reported only.
- **`kill` ends the turn and latches the session, not the process.** A forked or new session
  is a new root; a `claude` started through Bash is its own root.
- **Flags and settings that skip hooks:** `--bare`, `--safe-mode`, `--setting-sources`,
  `--settings '{"disableAllHooks": true}'`, `--restricted`, `allowManagedHooksOnly`, an
  untrusted folder (interactive). A managed install survives `--safe-mode`, `--restricted`,
  `--settings` and non-managed `disableAllHooks`.
- **No PreToolUse for `@` file references, `EndConversation` or `!` commands**; cloud
  sessions, VS Code and desktop are not verified.
- **Hook `ask` against a bare `Bash`/`PowerShell` allow rule is undocumented.** The installer
  refuses that rule unless `--force`.
- **Another hook's `updatedInput` races jev-cops's rewrite** (the last to finish wins).
- **The ask dialog also shows the tool input as Claude sent it**, including its
  `description`, next to jev-cops's reason, command and detail.
- **Headless comes from the parent argv.** A parent that cannot be read or is not
  recognizably `claude` counts as headless (holds denied); a launcher running `claude`
  without `-p` and with no human is taken for interactive, and a hold then becomes an ask
  that a host-less run denies and shows to Claude (row 28).
- **Reads and bookkeeping tools fail open** when the daemon is unreachable (warning and a
  line in `~/.jev-cops/claude-code-hook.log`); every other tool, MCP included, is blocked.
- **No `env.git` from the hook.** The daemon derives it from a repository the agent can
  write (D-067).
- **The socket is reachable by the agent without OpenShell.** Claude Code holds carry no
  resolvable token, so no precedent comes from Claude Code in M1.
- **Denied calls produce no post event.**
- **`harness_version` needs `~/.jev-cops/claude-code.json`** (install/doctor); omitted until then.
- **Windows backslash paths are not normalized in M1.**

## Codex

_Not yet built (M3)._

## OpenCode

_Not yet built (M3)._
