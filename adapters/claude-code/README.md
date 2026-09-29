# @jevdict/adapter-claude-code

The Jevdict command hook for [Claude Code](https://code.claude.com). Claude Code runs it on
every tool call, prompt, settings change and session start/end; it forwards each to
`jevdictd` as a canonical `jevdict.event/1` event or `jevdict.session/1` report, maps the
verdict back onto Claude Code's hook contract, and fails closed. It contains no policy.
Verified against the Claude Code docs for v2.1.285 and a real `claude` 2.1.280; the full
contract, every difference from the spec and the gap list are in
[`docs/adapters.md`](../../docs/adapters.md#claude-code).

| File | What it is |
|---|---|
| `src/hook-main.ts` | The entry compiled to `dist/jevdict-hook`: exit code 2 first, then the runtime. |
| `src/process.ts` | The fail-closed process shell: fatal handlers, stdin, deadlines, synchronous output. |
| `src/hook.ts` | One run: parse, dispatch, the hook's own deadline. |
| `src/events-pre.ts`, `src/events-session.ts` | `PreToolUse` → `/v1/judge`; posts, prompts, sessions and config changes. |
| `src/payload.ts`, `src/mapper.ts` | Hook stdin → typed input → canonical messages. |
| `src/output.ts`, `src/verdict.ts` | Verdict → exit code, stdout JSON and stderr (tighten only). |
| `src/intact.ts`, `src/settings.ts` | The ConfigChange check: is the jevdict hook still in force. |
| `src/mode.ts` | Headless detection from the parent `claude` argv. |
| `src/gaps.ts` | `CLAUDE_CODE_GAPS`, printed by install and doctor. |
| `testing/fake-claude.ts` | A fake Claude Code with the documented exit-code and JSON semantics, used by the tests. |

## Install by hand (until `jevdict install claude-code`, M1 step 6)

1. Start the daemon (`jevdictd --enforce`, or leave it in the default `observe` mode to log
   only) and build the hook: `bun run build:hook` → `dist/jevdict-hook`.
2. Add this block to `~/.claude/settings.json` (all projects) or a project's
   `.claude/settings.json`, merging it into any `hooks` you already have. Use absolute paths:
   exec form spawns `command` with no shell, so `~` is not expanded.

```json
{
  "hooks": {
    "PreToolUse": [{ "hooks": [{ "type": "command", "command": "/abs/path/dist/jevdict-hook", "args": ["--harness", "claude-code", "--socket", "/home/you/.jevdict/jevdictd.sock"], "timeout": 30 }] }],
    "PostToolUse": [{ "hooks": [{ "type": "command", "command": "/abs/path/dist/jevdict-hook", "args": ["--harness", "claude-code", "--socket", "/home/you/.jevdict/jevdictd.sock"], "timeout": 15 }] }],
    "PostToolUseFailure": [{ "hooks": [{ "type": "command", "command": "/abs/path/dist/jevdict-hook", "args": ["--harness", "claude-code", "--socket", "/home/you/.jevdict/jevdictd.sock"], "timeout": 15 }] }],
    "UserPromptSubmit": [{ "hooks": [{ "type": "command", "command": "/abs/path/dist/jevdict-hook", "args": ["--harness", "claude-code", "--socket", "/home/you/.jevdict/jevdictd.sock"], "timeout": 10 }] }],
    "ConfigChange": [{ "hooks": [{ "type": "command", "command": "/abs/path/dist/jevdict-hook", "args": ["--harness", "claude-code", "--socket", "/home/you/.jevdict/jevdictd.sock"], "timeout": 10 }] }],
    "SessionStart": [{ "hooks": [{ "type": "command", "command": "/abs/path/dist/jevdict-hook", "args": ["--harness", "claude-code", "--socket", "/home/you/.jevdict/jevdictd.sock"], "timeout": 10 }] }],
    "SessionEnd": [{ "hooks": [{ "type": "command", "command": "/abs/path/dist/jevdict-hook", "args": ["--harness", "claude-code", "--socket", "/home/you/.jevdict/jevdictd.sock"], "timeout": 10 }] }]
  }
}
```

3. Check it before relying on it: a mistyped path is a non-blocking error in Claude Code,
   so the gate would be silently off. Pipe a payload through the exact registered command:

```sh
echo '{"session_id":"canary","cwd":"'"$PWD"'","hook_event_name":"PreToolUse","tool_name":"Write","tool_input":{"file_path":"'"$PWD"'/.claude/settings.json","content":"{}"},"tool_use_id":"toolu_canary"}' \
  | /abs/path/dist/jevdict-hook --harness claude-code --socket /home/you/.jevdict/jevdictd.sock; echo "exit $?"
```

   In `enforce` mode this prints a JSON deny with `"continue":false` and `exit 2` (the
   `config-tamper` kill of a project `.claude/settings.json`; nothing is written, and the
   throw-away `canary` session stays latched). In `observe` mode it exits 0.

Keep every entry identical to the others and to the socket the daemon listens on: a
settings change that drops or alters one of the `PreToolUse`, `PostToolUse`,
`PostToolUseFailure`, `UserPromptSubmit` or `ConfigChange` entries is blocked and ends the
session ([intact](../../docs/adapters.md#intact)). An interactive session holds hooks back
until you accept the folder's workspace trust.

## How verdicts map

| Verdict | In Claude Code |
|---|---|
| `allow` | Exit 0, no output: Claude Code's normal permission flow decides. |
| `annotate` | Exit 0 with `additionalContext`: the note reaches Claude next to the tool result. |
| `rewrite` | Exit 0 with `updatedInput` and no decision: the pinned input runs, through the normal permission flow. |
| `hold` | Interactive, in a permission mode that prompts: Claude Code's own ask dialog, whose reason (shown to you, not to Claude) is jevdict's reason, the daemon's normalized command and its detail. Headless (`-p` without a permission host), `dontAsk`, `bypassPermissions`: denied. |
| `deny` | Exit 2: blocked; Claude sees `jevdict: <reason>`. |
| `kill` | Blocked with `continue: false`: Claude stops; every later call and prompt of the session is blocked. |

Failures fail closed: a daemon that is down, too slow (13 s), or answers anything but a
verdict for this call blocks it with `jevdict: judge unreachable (…)` or `jevdict: judge
timeout`. Only `Read`, `Glob`, `Grep` and Claude Code's bookkeeping tools proceed, with a
warning and a line in `~/.jevdict/claude-code-hook.log`. Post events never block. A prompt
the daemon could not record proceeds with a warning; a settings change it could not record
is blocked.

## Known gaps

`CLAUDE_CODE_GAPS` in `src/gaps.ts` (printed by `jevdict install claude-code` and `jevdict
doctor` from M1 steps 6–7), explained in
[`docs/adapters.md`](../../docs/adapters.md#gaps-jevdict-doctor-must-print-m1-1). In short:
a hook that cannot start or is killed lets calls through; without OpenShell every deny is
best-effort; `policy_settings` changes cannot be blocked; `kill` cannot exit Claude Code;
`--bare`, `--safe-mode`, `--settings`, `--restricted`, `disableAllHooks` and untrusted
folders skip hooks (a managed install survives some); `@` references, `EndConversation` and
`!` commands are never judged; the ask dialog also shows the tool input's own description.
