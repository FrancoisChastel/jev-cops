# @jevdict/adapter-pi

The Jevdict extension for [Pi](https://pi.dev). It forwards every Pi tool call to `jevdictd`
as a canonical `jevdict.event/1` event, maps the verdict back onto Pi's `tool_call`
contract, and reports every tool result as a post event. It contains no policy. Verified
against Pi v0.87.1; captured on a real Pi 0.83.0 run in
[`docs/captures/pi-m0.md`](../../docs/captures/pi-m0.md). The full contract and every
difference from the spec are in [`docs/adapters.md`](../../docs/adapters.md#pi).

| File | What it is |
|---|---|
| `jevdict.ts` | The extension. Node built-ins only; this one file is what gets installed. |
| `pi-types.ts` | The subset of Pi's extension types it uses (type-only import, erased at load). |
| `install.ts` | `installPiExtension()`: copies the extension into place and prints the known gaps. |
| `testing/fake-pi.ts` | A fake Pi runner with v0.87.1 semantics, used by the tests. |

## Install

Start the daemon first (`jevdictd --enforce`, or leave it in the default `observe` mode to
log only). Then install the extension using one of these options:

```sh
# Global: every project (Pi's agent dir, or $PI_CODING_AGENT_DIR)
mkdir -p ~/.pi/agent/extensions
cp adapters/pi/jevdict.ts ~/.pi/agent/extensions/jevdict.ts

# Project: loads only after you trust the project in Pi
mkdir -p .pi/extensions && cp adapters/pi/jevdict.ts .pi/extensions/jevdict.ts

# One run only
pi -e adapters/pi/jevdict.ts
```

The socket is resolved in this order: a path baked in by the installer, `$JEVDICT_SOCKET`,
then `~/.jevdict/jevdictd.sock` (the daemon's default). The installer does the copy and the
baking from code (the `jevdict install pi` command lands in M1):

```ts
import { installPiExtension } from "@jevdict/adapter-pi/install";
installPiExtension({ global: true, socket: "/run/jevdict/jevdictd.sock" });
```

When you run `pi -p` from a script whose stdin is a pipe, close stdin (`< /dev/null`).
Otherwise print mode waits on it.

## How verdicts map

| Verdict | In Pi |
|---|---|
| `allow` | Nothing returned; the tool runs. |
| `annotate` | The tool runs; `context_note` is appended to its result as a `[jevdict] …` text block (Pi's `tool_call` has no additional-context field). |
| `rewrite` | `event.input` is replaced in place by `updated_input` (Pi has no `updatedInput` return); the tool runs the pinned input. |
| `hold` | Interactive (`ctx.hasUI`: tui, rpc): `ctx.ui.confirm` shows the daemon's normalized raw command and its `detail` (fetched from `/v1/explain`), never the agent's text. Yes runs the tool and records a precedent through `/v1/resolve` (`by: "pi-user"`), presenting the verdict's single-use `hold_token`, which the model never sees. No blocks it. Headless (print, json): blocked (D-008; the daemon already sends `deny`). |
| `deny` | `{ block: true, reason: "jevdict: <reason>" }`. The reason is the tool result the model sees. |
| `kill` | Blocked with `terminate: true`, then `ctx.abort()` and `ctx.shutdown()`. |

Failures fail closed. A connection error, a non-200 reply, a 504 or client timeout (the
reason says "judge timeout", after 13 s), an invalid reply, or a verdict for another event
id all block the call. The exception is the read-only tools `read`, `grep`, `find` and
`ls`: they continue, and the adapter warns through `ctx.ui.notify` or stderr (spec T2,
observe-only events). Post events never block: the extension waits at most 2 s for
`/v1/observe` and only warns when it fails.

## Known gaps

`installPiExtension` prints these gaps, and `jevdict doctor` will print them from M1 on
(`PI_GAPS` in `install.ts`):

- **No OpenShell.** The agent can edit or delete the extension file, so every deny is
  best-effort.
- **`pi -ne` disables discovered extensions.** Only an explicit `-e` path still loads.
- **Project installs need trust.** They load only after the project is trusted in Pi.
- **No post event for denied calls.** A call blocked in `tool_call` produces no `tool_result`.
- **`kill` cannot shut down a headless run.** In print and json modes `shutdown` is a
  no-op, so `abort` is what ends the run.
- **No `env.git` is sent.** The daemon treats the unknown branch and repo as exposure.
- **Reads fail open.** Read-only tools continue when the daemon is down.
- **Other extensions' tools are opaque.** They are sent as kind `other`, and their nested
  agents are not linked as subagent sessions.
- **User-typed commands are not judged.** Commands the user types with `!` in the TUI
  (`user_bash`) skip `tool_call`.
