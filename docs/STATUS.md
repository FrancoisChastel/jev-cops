# Status

Updated: 2026-09-29

## Done

- Spec at `docs/SPEC.md`; M0 plan (`docs/PLAN-M0.md`); owner decisions D-008/D-009 recorded.
- Repo skeleton: Bun workspace, Biome lint/format, strict tsconfig, CI (ubuntu + macos),
  contribution docs, security policy, Apache-2.0.
- **M0 step 1 — schema** (`packages/core/src/schema`): `jev-cops.event/1` and
  `jev-cops.verdict/1` zod schemas, strict at every level, `parseEvent`/`parseVerdict`
  never throw, ULID/prefixed id validators, verdict ladder (`maxVerdict`, `raiseVerdict`,
  `isDenyClass`). 127 tests. Fixtures under `tests/fixtures/events/`. Decisions D-010–D-012.
- **M0 step 2 — normalizer** (`packages/core/src/normalizer`): tree-sitter-bash via WASM,
  flattening over pipes/lists/subshells/heredocs, base64/hex literal decoding with
  recursive parse of decoded shell, `~`/`$HOME`/relative path resolution with `cd`
  tracking, opaque flags (`command-substitution`, `eval`, `interpreter`, `heredoc-exec`,
  `decoded-pipe`, `dynamic-expansion`, `parse-error`), verb/kind classification tables,
  host + HTTP method extraction, `/dev/tcp` as net, stable `stateHash`. Adversarial pass
  closed four shell-out bypasses (`git -c`, `builtin`, `awk system()`, sed `e`).
  73-row command table at `tests/fixtures/commands/commands.json`. 477 tests.
  Decisions D-013–D-019.

- **M0 step 3 — context engine** (`packages/core/src/context`): case file (in-memory +
  bun:sqlite, one contract suite run against all three stores), secrets (path globs +
  content patterns), prompt-injection detector, taint with T10 laundering through
  self-written files, deterministic scope with task allowlist, four sequence patterns,
  environment, reversibility, risk budget with T7 hold doubling, `computeFeatures` with
  per-feature evidence. Spec worked examples asserted at the feature level.
  `tests/tamper/` T01–T13: T05/T06/T07/T09/T10/T11 live against core, the rest `todo`
  named with the spec's required outcome (see `tests/tamper/README.md`). 274 tests.
  Decisions D-020–D-027.

- **M0 step 4 (core) — judge** (`packages/core/src/judge`): provider-agnostic `Judge`
  interface with typed noul/choice/score questions and answers, mock + disabled judges,
  LRU/TTL cache, timeout + question-limit + validation guards, `buildJudgeState` that
  never carries agent prose. Decisions D-002, D-032.
- **M0 step 5 — policy engine** (`packages/core/src/policy`): floor formula and bands,
  `PolicyDefinition` contract (spec example type-checks unchanged), `PolicyEvent`/
  `PolicyContext` views, loader with 2 ms `when` cap, `combine` implementing spec rules
  1–5 + budget + precedents with a named test per rule, `createPolicyEngine` (139 lines).
  T6 floor-cap test live. 178 tests. Decisions D-028–D-037.

- **M0 steps 6–7 — SDK and starter policies**: `@jev-cops/sdk` (`definePolicy` with
  inferred answer types, `jev.noul/choice/score`, JSON fixture format + runner,
  `describeFixtures` for `bun test`), policies `tainted-destructive`,
  `default-branch-guard`, `off-repo-write`, `exfil-after-secrets` with 27 fixture cases
  that pass alone and with the whole set. Review fixes: D-038 (noul confidence), D-039
  (exfil fallback), D-040 (`/private/tmp`). 95 tests. Decisions D-038–D-041.

- **M0 step 4 (providers) — `@jev-cops/judge`**: `createJudge(config)` factory over
  `off | mock | jev | openrouter | vercel-ai`; TypeSafe Jev via `@typesafe-ai/sdk`,
  OpenRouter via plain `fetch` + `response_format.json_schema`, Vercel AI SDK v7 via
  `generateText` + `Output.object`; shared prompt/schema; contract suite (11 checks × 3
  providers) on fake transports; no network in tests. `.env.example`. 114 tests.
  Decisions D-042–D-046.

- **M0 steps 8–9 — daemon and CLI**: `copsd` (`packages/daemon`: TOML config with
  tighten-only repo override, hash-chained append-only audit log, SQLite precedents +
  sessions, policy hot reload, Unix socket + loopback HTTP, routes `/v1/judge`,
  `/v1/observe`, `/v1/resolve`, `/v1/explain/:id`, `/v1/health`, `/v1/budget/reset`,
  headless hold→deny, observe mode, 504 judge deadline); `jev-cops` (`packages/cli`:
  `test`, `explain`, `replay`, `budget`; `install`/`doctor` stubbed to M1); `bun run build`
  compiles both with the WASM grammar embedded; `dist/cops test policies` → PASS.
  Smoke-tested end to end: the spec's `git push --force` on `main`, headless → `deny`.
  T2/T3 (daemon side), T6 audit flag, T7 scope/TTL, T12 chain live. 137 tests.
  Decisions D-047–D-053.

- **M0 step 10 — Pi adapter** (`adapters/pi`): extension with 147 lines of logic, Node
  built-ins only, zero policy; installer with the known-gaps list; 20 end-to-end tests
  against a real `copsd` through a fake Pi runtime (block, headless deny, interactive
  confirm, rewrite, fail closed, judge timeout, task-once, kill). **Real `pi` run
  captured** (`docs/captures/pi-m0.md`): headless `git push --force origin main` blocked,
  relative `rm -rf ./build` rewritten to the pinned absolute path and executed. Pi
  verified at v0.87.1; 14 differences from the spec in `docs/adapters.md#pi`.
  T2/T3/T8/T9 adapter side live. Decisions D-054–D-058.

**Totals (after gate-review fixes):** 1637 tests + 10 todo, `bun run check` green,
coverage 98.4 % functions / 99.0 % lines (gate: 80 % per file), `bun run gate` PASS
(5 policies, 42 cases, 84 runs).

## M0 definition of done

| Item (spec §Milestones) | Status |
|---|---|
| Canonical schema | done |
| Normalizer with tree-sitter-bash | done |
| Context engine with all five features | done |
| SDK with `definePolicy` | done |
| Three starter policies with fixtures | done (five, incl. `opaque-exec`) |
| Pi adapter blocking and rewriting end to end | done, captured on real `pi` |
| Gate: `cops test` | PASS (4 policies, 27 cases, 54 runs) |

## M0 gate review (Fable 5.1, 2026-09-29): yes-with-fixes

No critical findings; every probed invariant held (fail closed, monotonic combine, detail
never reaches the harness, taint laundering, tighten-only config, precedent scope); fresh
clone → check → gate → build all green. Fixes before M1:

| # | Sev | Finding | Status |
|---|---|---|---|
| H1 | high | `/v1/resolve` and `/v1/budget/reset` are reachable from the agent's socket: an agent talking to the socket directly can self-approve a hold or reset its budget (T7/T8) | fixed: hold tokens (D-059), admin socket (D-060); verified with the reviewer's curl attack against the compiled daemon |
| M2 | medium | Obfuscated exec (`curl \| sh`, `python -c`, `eval`, `env -S`) is flagged opaque but ends `allow`: no floor weight and no `opaque-exec` policy yet | fixed: `opaque-exec` policy + `net-pipe` (D-062, D-063); `curl \| sh` → hold, `python -c` → annotate; T5 live end to end |
| M3 | medium | `env -S '<cmd>'` launders the verb and target (payload read as one word); `tar --to-command`, `ssh host '<cmd>'` hide the inner command | fixed: carriers parsed as shell, `dynamic-command` safety net (D-061, D-062) |
| L4 | low | CI runs `bun test --coverage` but `bunfig.toml` sets `coverage = false`: the 80 % threshold is never evaluated | fixed: per-file 80 % gate enforced; 98.4 % functions / 99.0 % lines (D-064) |
| L5 | low | README status stale | fixed |
| L6 | note | Audit chain is unkeyed SHA-256 from a public genesis: locally it detects mid-file edits/deletions, not truncation of the tail or a full rewrite. The real control is off-box shipping (M2); do not rely on local verification alone | documented (below) |

- **Pre-M1 hardening**: token-gated minimal `explain` on agent channels, full explain on
  the admin socket (D-065); scores stripped from agent-reachable verdicts (D-066); the
  daemon derives `env.git` from `cwd` with git hardened against agent-controlled
  `.git/config` — `filter` drivers and `ext::` lazy fetch closed, proven by canaries
  (D-067). Headless hold stays deny on Claude Code (D-070). 1721 tests + 10 todo.

- **M1 steps 1–2**: Claude Code tool table, harness CLIs, `git checkout --`/`restore` as
  writes, `ctx.env`/`ctx.config` for policies, D-068 main/master always default,
  `config-tamper` tiered (48 fixture cases). 6 policies · 93 cases · 186 runs PASS; 2025
  tests. Decisions D-071–D-074.

- **M1 step 3**: `POST /v1/session` (task once, harness pinning), kill latch with
  admin-only unlatch, config-change latch, hold→deny for headless/unattended permission
  modes, view-only token for Claude Code holds, `POST /v1/hooks/claude-code` for post
  events (PreToolUse refused over HTTP). T1/T11 daemon side live. 2181 tests. Decisions
  D-075–D-080.

- **M1 steps 4–5 — Claude Code hook** (`adapters/claude-code`, `cops hook`,
  `dist/cops-hook`): fail-closed command hook (exit 2 on every failure path, own 13 s
  deadline), tighten-only verdict mapping, hold→ask only with a human, session/prompt/
  config-change/post events, ConfigChange intact check. Verified live on `claude` 2.1.280
  against a local fake API (rewrite via `updatedInput`, kill via `continue: false`, prompt
  block; found that a headless `ask` reason reaches the model). Cold start p50 39 ms.
  Fake Claude Code runner e2e; T1/T2/T3/T8/T9 live on Claude Code. Daemon protects its
  own inputs; `explain`/`replay` read M1 lines. Decisions D-081–D-087.

**Totals:** 2615 tests + 6 todo, `bun run check` green, coverage 98.6 % functions /
99.1 % lines (80 % per file enforced), `bun run gate` PASS (6 policies, 93 cases, 186 runs),
`bun run build` → `dist/copsd`, `dist/cops`, `dist/cops-hook`.

- **M1 steps 6–7 — `cops install` and `cops doctor`**: installer for Claude Code (all
  scopes incl. managed drop-in, merge/backup/idempotent/uninstall/dry-run, refusals and
  warnings incl. 10 docs-drift items, offline canary with rollback) and Pi; read-only
  doctor with daemon/audit/settings/binary/trust checks, offline canary, gated live canary
  and every known gap printed. T4 installer + doctor halves live. Flaky policy-watch test
  made deterministic. Decisions D-089–D-092.

**Totals:** 2932 tests + 6 todo, coverage 98.7 % functions / 99.2 % lines, gate PASS.

## In progress

- M1 steps 8–9: one shared canary (doctor switches to the adapter's `runOfflineCanary`),
  remaining Claude Code tamper parts, docs, and a real interactive `claude` capture against
  a local fake API.

## Next

- Self-minted holds: an agent that posts its own `/v1/judge` gets that hold's token and a
  precedent matching its later real call; only OpenShell (keeping tool processes off the
  socket) closes it — T07 todo for M2.
- Carriers not yet parsed: `watch`, `script -c`, `tmux`/`screen` command strings, `flock`,
  `chroot`, `nsenter`, `sudo -s`, `vim -c '!…'`, `parallel`; T5 "exec of a freshly written
  file is judged on its content" uses the write's taint, not its content.
- M1 steps 6–9: `cops install claude-code`/`install pi` (writes the settings block,
  `[daemon] hook_binary`, `~/.jev-cops/claude-code.json` with the Claude Code version),
  `cops doctor` + offline/live canary, T4 installer gap, a real interactive `claude`
  capture covering: the ask dialog (text, newlines, whether a declined ask hides our reason
  from Claude), auto mode's classifier after a hook ask, ConfigChange on a real edit, SDK /
  VS Code parent argv (SDK hosts are headless today, D-086), `stopReason` display.

## Known gaps carried forward (from the normalizer report)

- Harness-specific tool names/fields (Pi `bash`, Codex array `command`, OpenCode) not yet
  in the tool table — added with each adapter.
- Claude Code `run_in_background` not mapped to spawn.
- Not expanded: brace expansion, `env -S`, aliases, `tar --to-command`, `vim -c`; inline
  python/node code is flagged opaque but not parsed.
- Coverage report: `bunfig.toml` has `coverage = false`; enable in CI once the threshold is met.
- SDK friction to address: `ctx.env.onDefaultBranch` and `ctx.config` helpers so policies
  stop duplicating D-024's list; `git push --force` normalizes to `net` so net policies
  match it with `net.host === null`; taint extractor registers `app.git` as a host; one
  missing recorded answer invalidates the whole batch (faithful to one request, but
  surprising for fixture authors).
- Audit log (L6): local verification detects mid-file edits and deletions only; tail
  truncation and full recompute need the off-box copy (M2) or a keyed chain.
- Policy engine: hot reload needs Bun's `import()` cache busted (daemon, step 8);
  `when`-overrun/degraded state is in-memory only; headless `hold → deny` (D-008) is the
  daemon/adapter's mapping, not `combine`'s.
- Context engine: `taintFraction` scans the whole taint set per event (~0.7 ms/event at
  1,600 calls) — needs an index before M4; `chargeHold` must be paired with `charge` by
  the daemon (types do not enforce it); SQLite schema has no migrations yet; in-repo
  `rm -f` scores reversibility 1 (D-026) — revisit with the starter policies.

## Blocked / waiting on owner

- Name check on PyPI and `.dev` (npm is free). Not blocking until publish.

## Working agreements

- Headless `hold` → `deny` (D-008); pilot thresholds = spec defaults (D-009).
- Planning and stage reviews on Fable 5.1; implementation on Opus 5.5.
