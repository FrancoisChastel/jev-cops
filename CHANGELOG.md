# Changelog

All notable changes to jev-cops are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html). Until 1.0, minor versions may
contain breaking changes; each one is called out below.

## [Unreleased]

### Added

- **Claude Code support** (M1): a fail-closed command hook for every tool call, prompt,
  settings change and session start/end; holds become Claude Code's own `ask` when a human
  is present and denies otherwise; a settings change that removes the hook ends the session.
  Verified against `claude` 2.1.280 and Agent SDK 0.3.285.
- `cops install claude-code|pi`: merges the hook into the harness settings with a backup,
  refuses unsafe setups (a bare `Bash` allow rule, `disableAllHooks`), supports user,
  project, local and managed scopes, `--dry-run` and `--uninstall`, and proves the install
  with an offline canary.
- `cops doctor`: checks the daemon on both sockets, the audit chain, each harness install
  and risky settings, runs a canary through the registered hook, and prints every known gap.
- `config-tamper` starter policy: kills writes to harness hook settings, extensions, the
  policies and the judge's own records; holds reads of the judge's records and attempts to
  stop the judge.
- Kill latch: after a `kill`, every later call of the session (and its subagents) is
  refused until a human clears it on the admin socket.
- Admin socket for human-only routes (budget reset, full explain); single-use hold tokens
  for approving a hold.

### Changed

- **Renamed from `jevdict` to `jev-cops`**: binaries `cops`, `copsd`, `cops-hook`;
  packages `@jev-cops/*`; config `~/.config/jev-cops/cops.toml`; state `~/.jev-cops/`;
  environment variables `JEV_COPS_*`; wire schemas `jev-cops.{event,verdict,session}/1`.
- Confirm prompts show the reason, the normalized command and the policies' plain-language
  findings, never scores (harnesses may persist the prompt where the agent can read it).
- Responses on agent-reachable channels no longer carry features or judge answers.

### Security

- The hook reads its parent process with `/bin/ps`, never `ps` from `PATH`.
- Agent SDK sessions are treated as headless, so a hold can never become a prompt with
  nobody to answer it.
- The daemon derives git state with a hardened `git` invocation that cannot run
  repository-configured programs (filters, fsmonitor, hooks, `ext::` transports).
- `dd`, `install`, `rsync`, archive extraction and copies into a directory are recognized
  as writes by the normalizer.

## [0.0.0] - 2026-09-29 (M0, unreleased)

### Added

- Canonical event and verdict schemas, a tree-sitter-bash normalizer (decoding, path
  resolution, opaque-construct detection), a context engine with five features, a policy
  engine with monotonic combination and a risk budget, the policy SDK with fixtures, five
  starter policies, pluggable semantic judge providers (TypeSafe Jev, OpenRouter, Vercel
  AI SDK), the `copsd` daemon with a hash-chained audit log, the `cops` CLI (`test`,
  `explain`, `replay`, `budget`) and the Pi adapter.

[Unreleased]: https://github.com/FrancoisChastel/jev-cops/commits/master
[0.0.0]: https://github.com/FrancoisChastel/jev-cops/commits/master
