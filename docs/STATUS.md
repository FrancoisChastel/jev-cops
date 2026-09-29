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

**Totals:** 878 tests + 12 todo, `bun run check` green, 42 commits.

## In progress

- Nothing. Session boundary reached (schema, normalizer, context engine delivered).

## Next (after this session)

- M0 step 4: `Judge` interface + providers (`mock`, `jev`, `openrouter`, `vercel-ai`), cache.
- M0 step 5: floor risk, policy loader, monotonic combination (−0.2 max) with its test.
- M0 steps 6–10: SDK, three starter policies + fixtures, daemon, `jevdict test`/`explain`, Pi adapter.

## Known gaps carried forward (from the normalizer report)

- Harness-specific tool names/fields (Pi `bash`, Codex array `command`, OpenCode) not yet
  in the tool table — added with each adapter.
- Claude Code `run_in_background` not mapped to spawn.
- Not expanded: brace expansion, `env -S`, aliases, `tar --to-command`, `vim -c`; inline
  python/node code is flagged opaque but not parsed.
- `bun build --compile` will need the grammar `.wasm` embedded (M0 step 10).
- Coverage report: `bunfig.toml` has `coverage = false`; enable in CI once the threshold is met.
- Context engine: `taintFraction` scans the whole taint set per event (~0.7 ms/event at
  1,600 calls) — needs an index before M4; `chargeHold` must be paired with `charge` by
  the daemon (types do not enforce it); SQLite schema has no migrations yet; in-repo
  `rm -f` scores reversibility 1 (D-026) — revisit with the starter policies.

## Blocked / waiting on owner

- Name check on PyPI and `.dev` (npm is free). Not blocking until publish.

## Working agreements

- Headless `hold` → `deny` (D-008); pilot thresholds = spec defaults (D-009).
- Planning and stage reviews on Fable 5.1; implementation on Opus 5.5.
