# Adapter notes

Per harness: what the official docs say today, where they differ from `SPEC.md`
(dated 2026-09-29), and the gaps `jevdict doctor` must print. Each section is filled
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
- `env`: `{ sandbox: { kind: "none" } }`. No `env.git`: jevdictd derives it from `cwd`
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
| annotate | the tool runs; `context_note` is appended to the tool result as a `[jevdict] …` text block in `tool_result`. A note from any verdict is appended, including observe mode's "would have". |
| rewrite | `event.input` is replaced in place: keys missing from `updated_input` are deleted, the rest assigned. Nothing is returned. |
| hold | interactive: `GET /v1/explain/<id>` with `Authorization: Bearer <hold_token>`, which on the agent socket returns only the confirm view `{ event_id, verdict, reason, raw, detail }` of a pending hold, then `ctx.ui.confirm("Jevdict hold: <reason>", "<normalized raw>\n\n<detail>")`. Yes posts `/v1/resolve` `allow`, `by: "pi-user"` with the verdict's `hold_token`, and the tool runs. No posts `deny` (with the token) and blocks. The token stays in the extension: the model only ever sees `reason`, and the daemon refuses a view or a resolve without it (403 and an `anomaly` line). When the verdict carries no token or the view cannot be loaded, the call is blocked without asking. Headless: blocked (the daemon already sends `deny`, D-008, and mints no token). |
| deny | `{ block: true, reason: "jevdict: <reason>" }` |
| kill | `{ block: true, reason, terminate: true }` plus `ctx.abort()` and `ctx.shutdown()` |

Failures. A transport error, a non-200 reply, an invalid reply, or a verdict whose
`event_id` is not the event's all block the call with `jevdict: judge unreachable (…);
blocking (fail closed)`. A 504 or a client timeout (13 s = the daemon's 12 s deadline + 1 s)
blocks it with `jevdict: judge timeout; …` (T3). The exception is `fs.read` tools, which
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
    input. The jevdict audit log has both: the `judge` line has the original, the
    `observe` line the pinned input.
13. **`ctx.shutdown()` is a no-op in print and json modes.** No shutdown handler is bound
    in `print-mode.ts`, so `ctx.abort()` is what ends a headless run.
14. **The extension runs on Node, inside Pi's own process.** This is not the spec's
    compiled Bun hook binary, so no extra runtime is needed.

### Gaps `jevdict doctor` must print (M1)

These are the `PI_GAPS` strings in `adapters/pi/install.ts`, which the installer already
prints:

- **Without OpenShell, every deny is best-effort.** The agent can edit or delete the
  extension file (T1, T4).
- **`pi --no-extensions` / `-ne` starts Pi without jevdict.** Only an explicit `-e` still
  loads.
- **Project installs are inactive until the project is trusted.**
- **Denied calls produce no post event.**
- **`kill` relies on `ctx.abort()` in headless runs.** `terminate` is a batch hint, and
  `shutdown` is a no-op in print and json modes.
- **No `env.git` from the adapter; jevdictd derives it.** The adapter stays
  dependency-free and never shells out to git. For an event without `env.git` (or
  without `repo`/`branch`) the daemon derives, outside the sandbox and from `call.cwd`:
  the repo root, the branch (none when detached), the default branch from `origin/HEAD`
  and dirty, plus the origin host for scope. Git runs with argv arrays, a scrubbed
  environment and fsmonitor, hooks, pager and every transport switched off, within
  `daemon.git_probe_timeout_ms` (300 ms), cached per cwd for 5 s; dirty is computed from
  index stat data so no filter driver can run. What the daemon filled in is on the audit
  line as `derived.git`, and `jevdict explain` shows it. The values still come from a
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
  it can connect to `jevdictd.sock` itself. The hold token stops it from approving, or
  reading the confirm view of, a hold the extension received (it never sees the verdict
  response), but it can post judge requests of its own and resolve or view those.
  `jevdictd-admin.sock` (budget reset, full explain) is human-only only when it is not
  mounted into the sandbox.

### Sockets

The extension talks to the agent socket only (`~/.jevdict/jevdictd.sock`, or the path the
installer baked in). `jevdictd` also listens on an admin socket
(`~/.jevdict/jevdictd-admin.sock`, `daemon.admin_socket`) that serves `/v1/budget/reset`,
`/v1/health` and the full `/v1/explain/<id>` (the audit line with trace, features and
evidence); the agent socket answers `/v1/budget/reset` with 404, and serves
`/v1/explain/<id>` only as the confirm view of a pending hold to a caller presenting its
token as a Bearer header (403 and an `anomaly` line without it, 404 once the hold is
resolved or expired). Loopback HTTP, when enabled, is an agent channel with the same
rules. On agent channels a verdict also carries no scores: `features: {}`, `jev: []`,
`risk` to one decimal (the audit line keeps the exact values).
Never mount the admin socket into a sandbox: `jevdict budget <session> --reset` is how a
human resets a budget.

## Claude Code

_Not yet built (M1)._

## Codex

_Not yet built (M3)._

## OpenCode

_Not yet built (M3)._
