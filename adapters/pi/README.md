# @jev-cops/adapter-pi

The jev-cops extension for [Pi](https://pi.dev). It forwards every Pi tool call to `copsd`
as a canonical `jev-cops.event/1` event, maps the verdict back onto Pi's `tool_call`
contract, and reports every tool result as a post event. It contains no policy. Verified
against Pi v0.87.1; captured on a real Pi 0.83.0 run in
[`docs/captures/pi-m0.md`](../../docs/captures/pi-m0.md). The full contract and every
difference from the spec are in [`docs/adapters.md`](../../docs/adapters.md#pi).

| File | What it is |
|---|---|
| `jev-cops.ts` | The extension. Node built-ins only; this one file is what gets installed. |
| `pi-types.ts` | The subset of Pi's extension types it uses (type-only import, erased at load). |
| `install.ts` | `installPiExtension()` / `uninstallPiExtension()`, behind `cops install pi`: copies the extension into place (or removes it) and prints the known gaps. |
| `testing/fake-pi.ts` | A fake Pi runner with v0.87.1 semantics, used by the tests. |

## Install

Start the daemon first (`copsd --enforce`, or leave it in the default `observe` mode to
log only). Then install the extension with the CLI:

```sh
./dist/cops install pi                    # global: ~/.pi/agent/extensions (or $PI_CODING_AGENT_DIR)
./dist/cops install pi --project          # <project>/.pi/extensions: loads only after you trust the project
./dist/cops install pi --socket /run/jev-cops/copsd.sock   # bake the daemon socket into the file
./dist/cops install pi --dry-run          # where it would go; writes nothing
./dist/cops install pi --uninstall        # removes the jev-cops extension (and nothing else)
```

`--home <dir>` and `--project-dir <dir>` install somewhere else (with `--home`, a
`PI_CODING_AGENT_DIR` outside it is ignored); `--json` prints one JSON object. Every run
prints the known gaps below. Exit codes: 0 done, 1 failed (for example an uninstall that
finds a file that is not the jev-cops extension), 2 usage.

The socket is resolved in this order: a path baked in by the installer, `$JEV_COPS_SOCKET`,
then `~/.jev-cops/copsd.sock` (the daemon's default). That is the agent socket. The
daemon's admin socket (`~/.jev-cops/copsd-admin.sock`, budget resets) is for a human's
shell only: never point the extension at it or mount it into a sandbox.

When you run `pi -p` from a script whose stdin is a pipe, close stdin (`< /dev/null`).
Otherwise print mode waits on it.

## How verdicts map

| Verdict | In Pi |
|---|---|
| `allow` | Nothing returned; the tool runs. |
| `annotate` | The tool runs; `context_note` is appended to its result as a `[jev-cops] …` text block (Pi's `tool_call` has no additional-context field). |
| `rewrite` | `event.input` is replaced in place by `updated_input` (Pi has no `updatedInput` return); the tool runs the pinned input. |
| `hold` | Interactive (`ctx.hasUI`: tui, rpc): `ctx.ui.confirm` shows the daemon's normalized raw command and its `detail` (the confirm view from `/v1/explain`, which the daemon serves on the agent socket only with the verdict's `hold_token` as a Bearer header), never the agent's text. A hold without a token, or whose view cannot be loaded, is blocked without asking. Yes runs the tool and records a precedent through `/v1/resolve` (`by: "pi-user"`), presenting the verdict's single-use `hold_token`, which the model never sees. No blocks it. Headless (print, json): blocked (D-008; the daemon already sends `deny`). |
| `deny` | `{ block: true, reason: "jev-cops: <reason>" }`. The reason is the tool result the model sees. |
| `kill` | Blocked with `terminate: true`, then `ctx.abort()` and `ctx.shutdown()`. |

Failures fail closed. A connection error, a non-200 reply, a 504 or client timeout (the
reason says "judge timeout", after 13 s), an invalid reply, or a verdict for another event
id all block the call. The exception is the read-only tools `read`, `grep`, `find` and
`ls`: they continue, and the adapter warns through `ctx.ui.notify` or stderr (spec T2,
observe-only events). Post events never block: the extension waits at most 2 s for
`/v1/observe` and only warns when it fails.

## Known gaps

`cops install pi` prints these gaps, and `cops doctor` will print them from M1 step 7
(`PI_GAPS` in `install.ts`):

- **No OpenShell.** The agent can edit or delete the extension file, so every deny is
  best-effort.
- **`pi -ne` disables discovered extensions.** Only an explicit `-e` path still loads.
- **Project installs need trust.** They load only after the project is trusted in Pi.
- **No post event for denied calls.** A call blocked in `tool_call` produces no `tool_result`.
- **`kill` cannot shut down a headless run.** In print and json modes `shutdown` is a
  no-op, so `abort` is what ends the run.
- **No `env.git` is sent; the daemon derives it.** copsd reads repo, branch, default
  branch (`origin/HEAD`) and dirty from the call's cwd with hardened read-only git. The
  repository is the agent's to write, so it can steer those values (for example move
  `origin/HEAD` so `main` stops counting as the default branch); what cannot be derived is
  treated as exposure (D-024).
- **Reads fail open.** Read-only tools continue when the daemon is down.
- **Other extensions' tools are opaque.** They are sent as kind `other`, and their nested
  agents are not linked as subagent sessions.
- **User-typed commands are not judged.** Commands the user types with `!` in the TUI
  (`user_bash`) skip `tool_call`.
- **The sockets are reachable by the agent without OpenShell.** The hold token keeps the
  agent from approving, or reading the confirm view of, a hold this extension received,
  but it can post its own judge requests; the admin socket (budget reset, full explain) is
  human-only only when it is not mounted into the sandbox.

## Appendix: install by hand

```sh
# Global: every project (Pi's agent dir, or $PI_CODING_AGENT_DIR)
mkdir -p ~/.pi/agent/extensions
cp adapters/pi/jev-cops.ts ~/.pi/agent/extensions/jev-cops.ts

# Project: loads only after you trust the project in Pi
mkdir -p .pi/extensions && cp adapters/pi/jev-cops.ts .pi/extensions/jev-cops.ts

# One run only
pi -e adapters/pi/jev-cops.ts
```

Or from code, which is what `cops install pi` calls:

```ts
import { installPiExtension } from "@jev-cops/adapter-pi/install";
installPiExtension({ global: true, socket: "/run/jev-cops/copsd.sock" });
```
