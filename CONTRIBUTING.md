# Contributing

Thanks for helping. jev-cops is security tooling, so the bar is: every behaviour has a
test, every adapter has zero policy logic, and nothing is allowed because something
timed out.

## Setup

```bash
git clone https://github.com/FrancoisChastel/jev-cops && cd jev-cops
bun install
bun run check        # lint + typecheck + tests
```

Bun ≥ 1.3 is required (`bun:sqlite`, `bun build --compile`). Node is not a supported runtime.

## Ground rules

- Read `docs/SPEC.md` first. It is the source of truth; `docs/DECISIONS.md` records
  choices the spec left open.
- Adapters (`adapters/*`) translate harness events to the canonical schema and verdicts
  back. They contain **no** judging logic and stay under 150 lines.
- Fail closed on the `deny` class, fail open on `observe`. A daemon timeout is never an allow.
- Verdicts are monotonic. No model answer lowers the deterministic floor by more than 0.2.
  There is a test for this; keep it green.
- Every policy in `policies/` ships with a `*.fixtures.json`; `cops test` fails on any mismatch.
- Every threat T1–T13 in the spec has a file under `tests/tamper/`. Do not delete or
  weaken one; if it cannot pass yet, leave it as `test.todo` with the spec outcome as its name.
- No features outside the spec. Ambiguity listed under "Open decisions" gets asked in an
  issue; anything else takes the safer option and a row in `docs/DECISIONS.md`.

## Live tests run in Docker, never on your machine

Tests and scripts must never run, install or configure a real harness (`claude`, `codex`,
`opencode`, `pi`), a scanner, or your login session's services on the host. Unit and e2e
tests use fakes and throwaway `HOME` directories; live verification against real harness
binaries runs only inside the Docker images under `docker/`, against a fake model API on
an internal network, with no real credentials (see `scripts/live/`). How it works, how to
run it (`JEV_COPS_LIVE=1 scripts/live/e2e.sh`) and what it guarantees:
[docs/live-testing.md](./docs/live-testing.md).

## Workflow

1. Write the test first, watch it fail.
2. Implement the smallest change that makes it pass.
3. `bun run check` must be green.
4. Small commits, one concern each, conventional messages: `feat:`, `fix:`, `test:`,
   `docs:`, `refactor:`, `chore:`, `ci:`.
5. Open a PR with what changed, why, and how it was tested. CI runs lint, typecheck and
   tests on every PR.

## Code style

Biome enforces formatting and lint (`bun run lint:fix`). TypeScript strict mode with
`noUncheckedIndexedAccess`. Prefer small modules (200–400 lines), pure functions, and
returning new objects over mutating inputs. No `any`.

## Reporting a security issue

See [SECURITY.md](./SECURITY.md). Please do not open a public issue for a bypass.
