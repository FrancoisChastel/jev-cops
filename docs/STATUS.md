# Status

Updated: 2026-09-29

## Done

- Spec at `docs/SPEC.md`; M0 plan (`docs/PLAN-M0.md`); owner decisions D-008/D-009 recorded.
- Repo skeleton: Bun workspace, Biome lint/format, strict tsconfig, CI (ubuntu + macos),
  contribution docs, security policy, Apache-2.0.
- **M0 step 1 — schema** (`packages/core/src/schema`): `jevdict.event/1` and
  `jevdict.verdict/1` zod schemas, strict at every level, `parseEvent`/`parseVerdict`
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

- **M0 steps 6–7 — SDK and starter policies**: `@jevdict/sdk` (`definePolicy` with
  inferred answer types, `jev.noul/choice/score`, JSON fixture format + runner,
  `describeFixtures` for `bun test`), policies `tainted-destructive`,
  `default-branch-guard`, `off-repo-write`, `exfil-after-secrets` with 27 fixture cases
  that pass alone and with the whole set. Review fixes: D-038 (noul confidence), D-039
  (exfil fallback), D-040 (`/private/tmp`). 95 tests. Decisions D-038–D-041.

- **M0 step 4 (providers) — `@jevdict/judge`**: `createJudge(config)` factory over
  `off | mock | jev | openrouter | vercel-ai`; TypeSafe Jev via `@typesafe-ai/sdk`,
  OpenRouter via plain `fetch` + `response_format.json_schema`, Vercel AI SDK v7 via
  `generateText` + `Output.object`; shared prompt/schema; contract suite (11 checks × 3
  providers) on fake transports; no network in tests. `.env.example`. 114 tests.
  Decisions D-042–D-046.

- **M0 steps 8–9 — daemon and CLI**: `jevdictd` (`packages/daemon`: TOML config with
  tighten-only repo override, hash-chained append-only audit log, SQLite precedents +
  sessions, policy hot reload, Unix socket + loopback HTTP, routes `/v1/judge`,
  `/v1/observe`, `/v1/resolve`, `/v1/explain/:id`, `/v1/health`, `/v1/budget/reset`,
  headless hold→deny, observe mode, 504 judge deadline); `jevdict` (`packages/cli`:
  `test`, `explain`, `replay`, `budget`; `install`/`doctor` stubbed to M1); `bun run build`
  compiles both with the WASM grammar embedded; `dist/jevdict test policies` → PASS.
  Smoke-tested end to end: the spec's `git push --force` on `main`, headless → `deny`.
  T2/T3 (daemon side), T6 audit flag, T7 scope/TTL, T12 chain live. 137 tests.
  Decisions D-047–D-053.

**Totals:** 1412 tests + 9 todo, `bun run check` green, `bun run gate` PASS.

## In progress

- M0 step 10: Pi adapter (`adapters/pi`): blocking + rewriting end to end with a captured
  run; `docs/adapters.md` Pi section from the v0.87.1 docs.

## Next

- M0 gate review, then M1 (Claude Code hooks, `install`, `doctor`, config-tamper policy).

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
