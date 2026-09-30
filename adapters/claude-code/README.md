# @jev-cops/adapter-claude-code

The jev-cops command hook for [Claude Code](https://code.claude.com). Claude Code runs it on
every tool call, prompt, settings change and session start/end; it forwards each to
`copsd` as a canonical `jev-cops.event/1` event or `jev-cops.session/1` report, maps the
verdict back onto Claude Code's hook contract, and fails closed. It contains no policy.
Verified against the Claude Code docs for v2.1.285, a real interactive `claude` 2.1.280 and
Agent SDK 0.3.285 runs ([live capture](../../docs/captures/claude-code-m1.md)); the full
contract, every difference from the spec and the gap list are in
[`docs/adapters.md`](../../docs/adapters.md#claude-code).

In short: build, start `copsd`, run `cops install claude-code`, then `cops doctor`.

| File | What it is |
|---|---|
| `src/hook-main.ts` | The entry compiled to `dist/cops-hook`: exit code 2 first, then the runtime. |
| `src/process.ts` | The fail-closed process shell: fatal handlers, stdin, deadlines, synchronous output. |
| `src/hook.ts` | One run: parse, dispatch, the hook's own deadline. |
| `src/events-pre.ts`, `src/events-session.ts` | `PreToolUse` → `/v1/judge`; posts, prompts, sessions and config changes. |
| `src/payload.ts`, `src/mapper.ts` | Hook stdin → typed input → canonical messages. |
| `src/output.ts`, `src/verdict.ts` | Verdict → exit code, stdout JSON and stderr (tighten only). |
| `src/intact.ts`, `src/settings.ts` | The ConfigChange check: is the cops hook still in force. |
| `src/mode.ts` | Headless detection from the parent `claude` argv. |
| `src/gaps.ts` | `CLAUDE_CODE_GAPS`, printed by install and doctor. |
| `src/install.ts`, `src/refusals.ts` | `cops install claude-code`, the settings half: scopes, refusals, warnings, merge, write, uninstall, rollback. |
| `src/hook-entries.ts`, `src/settings-merge.ts`, `src/settings-io.ts` | The entries it registers, the pure merge/strip, the atomic write with backup. |
| `src/canary.ts` | `runOfflineCanary`: the hook run exactly as registered on two synthetic calls; the one canary of `cops install` and `cops doctor`. |
| `src/hook-binary.ts`, `src/install-state.ts`, `src/spawn.ts` | The hook binary checks, `~/.jev-cops/claude-code.json`, a never-throwing process runner. |
| `testing/fake-claude.ts` | A fake Claude Code with the documented exit-code and JSON semantics, used by the tests. |

## Install

1. Build the binaries and start the daemon: `bun run build` (→ `dist/copsd`, `dist/cops`,
   `dist/cops-hook`), then `./dist/copsd --enforce`, or leave the default `observe` mode to
   log only.
2. Register the hook: `./dist/cops install claude-code` (see what it would change first with
   `--dry-run`).
3. Check it: `./dist/cops doctor` (read-only; `--harness claude-code` to skip Pi). It checks
   copsd on both sockets, the audit chain, the `claude` version, that the hook is in force on
   every event it needs, the binary, the socket, risky settings and workspace trust, runs the
   same canary as the install through the registered entry, and prints every known gap. Exit
   1 on any failure.

```sh
./dist/cops install claude-code                  # ~/.claude/settings.json (or $CLAUDE_CONFIG_DIR)
./dist/cops install claude-code --project        # <project>/.claude/settings.json, shared
./dist/cops install claude-code --local          # <project>/.claude/settings.local.json
sudo ./dist/cops install claude-code --managed \
  --socket "$HOME/.jev-cops/copsd.sock" \
  --hook-binary /usr/local/libexec/jev-cops/cops-hook   # admins: a root-owned hook binary
./dist/cops install claude-code --uninstall      # removes only jev-cops's entries
```

| Option | Effect |
|---|---|
| `--user` (default), `--project`, `--local`, `--managed` | Which settings file (one per run). `--managed` writes `<managed dir>/managed-settings.d/50-jev-cops.json` (macOS `/Library/Application Support/ClaudeCode`, Linux `/etc/claude-code`, Windows `C:\Program Files\ClaudeCode`) only when run as root; otherwise it prints the JSON and the path for an administrator and exits 1. It never runs sudo, writes no cops.toml or state file (it prints the `[daemon] hook_binary` line instead), and warns when the hook binary is not root-owned. A managed install keeps working under `--safe-mode`, `--restricted`, `--settings` and a non-managed `disableAllHooks`; it is skipped when server-managed settings or an MDM profile supply the managed policy (first-wins, see `/status`). |
| `--socket <path>` | The daemon's agent socket. Default: `[daemon] socket` from cops.toml, `~/.jev-cops/copsd.sock`. |
| `--transport http` | Post events go to the daemon's loopback HTTP listener (`[daemon] http` must be set). `PreToolUse` always stays the command hook, because HTTP hooks fail open. |
| `--hook-binary <path>` | Default: `cops-hook` next to `cops`, else `cops-hook` on `PATH`. |
| `--config <path>` | The cops.toml that records `[daemon] hook_binary`. Default: `~/.config/jev-cops/cops.toml`. |
| `--home <dir>`, `--project-dir <dir>` | Install under another home directory or project. With `--home`, `CLAUDE_CONFIG_DIR` and `JEV_COPS_CONFIG` are ignored when they point outside it. |
| `--dry-run` | Print the diff and what would be recorded; write nothing. |
| `--force` | Install despite a refusal. Each refusal is then printed as `FORCED: …` and recorded in the result. |
| `--json` | One JSON object (settings text left out, except a dry run's diff). |

What an install does, in order:

1. **Checks the hook binary.** It must exist, be executable, and print the same version as
   `cops --version`. Claude Code treats a hook that cannot start as a non-blocking error, so
   a mistyped path would silently switch the gate off.
2. **Reads every settings file Claude Code loads and refuses** on:
   - a bare `Bash`, `Bash(*)`, `PowerShell` or `Monitor` allow rule at any scope (spec: the
     installer refuses when `Bash` is on the allow list);
   - `disableAllHooks` (for a non-managed install), or `disableAllHooks` in managed settings
     (for any install);
   - `allowManagedHooksOnly` for a non-managed install;
   - `--transport http` without the daemon's HTTP bind, or without an `allowedHttpHookUrls`
     entry that admits it.
3. **Merges the entries** into the file, one group per event with no matcher, in exec form.
   Foreign hooks, other keys and key order are left alone, and stale jev-cops entries are
   replaced. The write is atomic, and the previous file is backed up as
   `<file>.jev-cops-<UTC time>.bak` (mode 0600). User and local files are 0600. Running the
   install again changes nothing.
4. **Records the install** (not for `--managed`). It sets `[daemon] hook_binary` in cops.toml, which makes copsd
   protect the binary from its next start. It also writes `~/.jev-cops/claude-code.json`,
   whose `claude_version` (from `claude --version`) the hook reports as `harness_version`.
5. **Runs the offline canary** through the entry exactly as written. `Bash true` must exit
   0 silently, and a `Write` to `~/.claude/settings.json` must exit 2 with `continue: false`
   (the `config-tamper` kill).
   - If the daemon is down, the install still succeeds, with the warning "daemon not
     reachable: the hook will block every non-read call until copsd runs (fail closed)".
   - If the daemon is in `observe` mode, that is reported.
   - Any other answer exits 1, and the settings, cops.toml and state are rolled back.
6. **Prints the warnings and gaps.** Warnings cover a `bypassPermissions`/`dontAsk` default
   mode (holds become denies), an untrusted workspace, a project install below the
   repository root, and `CLAUDE_CONFIG_DIR`. Every install also says that
   `--dangerously-skip-permissions` is out of scope for the hook, that without OpenShell
   every deny is best-effort, and prints every gap below.

Exit codes: 0 installed (or already, removed, a dry run), 1 refused or failed, 2 usage.

An interactive session holds hooks back until you accept the folder's workspace trust. A
settings change that drops or alters one of the `PreToolUse`, `PostToolUse`,
`PostToolUseFailure`, `UserPromptSubmit` or `ConfigChange` entries is blocked and ends the
session ([intact](../../docs/adapters.md#intact)): uninstall with `cops install claude-code
--uninstall` outside a Claude Code session.

## How verdicts map

| Verdict | In Claude Code |
|---|---|
| `allow` | Exit 0, no output: Claude Code's normal permission flow decides. |
| `annotate` | Exit 0 with `additionalContext`: the note reaches Claude next to the tool result. |
| `rewrite` | Exit 0 with `updatedInput` and no decision: the pinned input runs, through the normal permission flow. |
| `hold` | Interactive, in a permission mode that prompts: Claude Code's own ask dialog, whose reason (shown to you, not to Claude) is jev-cops's reason, the daemon's normalized command, the matched policies' plain-language lines and a `cops explain <event-id>` pointer. No score: Claude Code keeps this text in the session transcript, which the agent can read, so features, floor, risk and the rest of the scored detail are only in `cops explain`. Headless (`-p`, or the Agent SDK, without a permission host), `dontAsk`, `bypassPermissions`: denied. With an SDK `canUseTool` host, the host receives the ask. |
| `deny` | Exit 2: blocked; Claude sees `jev-cops: <reason>`. |
| `kill` | Blocked with `continue: false`: Claude stops; every later call and prompt of the session is blocked. |

Failures fail closed: a daemon that is down, too slow (13 s), or answers anything but a
verdict for this call blocks it with `jev-cops: judge unreachable (…)` or `jev-cops: judge
timeout`. Only `Read`, `Glob`, `Grep` and Claude Code's bookkeeping tools proceed, with a
warning and a line in `~/.jev-cops/claude-code-hook.log`. Post events never block. A prompt
the daemon could not record proceeds with a warning; a settings change it could not record
is blocked.

## Known gaps

`CLAUDE_CODE_GAPS` in `src/gaps.ts` (printed by `cops install claude-code` and `cops
doctor`), explained in
[`docs/adapters.md`](../../docs/adapters.md#gaps-cops-doctor-must-print-m1-1). In short:
a hook that cannot start or is killed lets calls through; without OpenShell every deny is
best-effort; `policy_settings` changes cannot be blocked; `kill` cannot exit Claude Code;
`--bare`, `--safe-mode`, `--settings`, `--restricted`, `disableAllHooks` and untrusted
folders skip hooks (a managed install survives some); `@` references, `EndConversation` and
`!` commands are never judged; the ask dialog also shows the tool input's own description;
the ask's text (reason, command and the policies' lines, no score) is kept in the session
transcript, which the agent can read.

## Appendix: the settings block by hand

`cops install claude-code` writes this. To do it yourself:
1. Start the daemon (`copsd --enforce`, or leave it in the default `observe` mode to log
   only) and build the hook: `bun run build:hook` → `dist/cops-hook`.
2. Add this block to `~/.claude/settings.json` (all projects) or a project's
   `.claude/settings.json`, merging it into any `hooks` you already have. Use absolute paths:
   exec form spawns `command` with no shell, so `~` is not expanded.

```json
{
  "hooks": {
    "PreToolUse": [{ "hooks": [{ "type": "command", "command": "/abs/path/dist/cops-hook", "args": ["--harness", "claude-code", "--socket", "/home/you/.jev-cops/copsd.sock"], "timeout": 30 }] }],
    "PostToolUse": [{ "hooks": [{ "type": "command", "command": "/abs/path/dist/cops-hook", "args": ["--harness", "claude-code", "--socket", "/home/you/.jev-cops/copsd.sock"], "timeout": 15 }] }],
    "PostToolUseFailure": [{ "hooks": [{ "type": "command", "command": "/abs/path/dist/cops-hook", "args": ["--harness", "claude-code", "--socket", "/home/you/.jev-cops/copsd.sock"], "timeout": 15 }] }],
    "UserPromptSubmit": [{ "hooks": [{ "type": "command", "command": "/abs/path/dist/cops-hook", "args": ["--harness", "claude-code", "--socket", "/home/you/.jev-cops/copsd.sock"], "timeout": 10 }] }],
    "ConfigChange": [{ "hooks": [{ "type": "command", "command": "/abs/path/dist/cops-hook", "args": ["--harness", "claude-code", "--socket", "/home/you/.jev-cops/copsd.sock"], "timeout": 10 }] }],
    "SessionStart": [{ "hooks": [{ "type": "command", "command": "/abs/path/dist/cops-hook", "args": ["--harness", "claude-code", "--socket", "/home/you/.jev-cops/copsd.sock"], "timeout": 10 }] }],
    "SessionEnd": [{ "hooks": [{ "type": "command", "command": "/abs/path/dist/cops-hook", "args": ["--harness", "claude-code", "--socket", "/home/you/.jev-cops/copsd.sock"], "timeout": 10 }] }]
  }
}
```

3. Check it before relying on it: a mistyped path is a non-blocking error in Claude Code,
   so the gate would be silently off. Pipe a payload through the exact registered command:

```sh
echo '{"session_id":"canary","cwd":"'"$PWD"'","hook_event_name":"PreToolUse","tool_name":"Write","tool_input":{"file_path":"'"$PWD"'/.claude/settings.json","content":"{}"},"tool_use_id":"toolu_canary"}' \
  | /abs/path/dist/cops-hook --harness claude-code --socket /home/you/.jev-cops/copsd.sock; echo "exit $?"
```

   In `enforce` mode this prints a JSON deny with `"continue":false` and `exit 2` (the
   `config-tamper` kill of a project `.claude/settings.json`; nothing is written, and the
   throw-away `canary` session stays latched). In `observe` mode it exits 0.

Keep every entry identical to the others and to the socket the daemon listens on: a
settings change that drops or alters one of the `PreToolUse`, `PostToolUse`,
`PostToolUseFailure`, `UserPromptSubmit` or `ConfigChange` entries is blocked and ends the
session ([intact](../../docs/adapters.md#intact)). An interactive session holds hooks back
until you accept the folder's workspace trust.
