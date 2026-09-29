# Status

Updated: 2026-09-29

## Done

- Spec moved to `docs/SPEC.md`; M0 plan written (`docs/PLAN-M0.md`).
- Repo skeleton: Bun workspace, Biome lint/format, CI, contribution docs, license.
- Verified toolchain: Bun 1.3.13; `web-tree-sitter@0.27.0` loads the WASM grammar
  from `tree-sitter-bash@0.25.1` under Bun; `@typesafe-ai/sdk@0.6.0` API shape read
  from source (see DECISIONS D-002).

## Next (this session, in order)

1. `packages/core/src/schema` — event + verdict schemas with validation and tests.
2. `packages/core/src/normalizer` — tree-sitter-bash normalizer with tests.
3. `packages/core/src/context` — case file and the five features with tests.
4. `tests/tamper/` — T1–T13 files, each asserting the spec's required outcome; core-level
   ones live, the rest `todo` until their milestone.

Then stop and report.

## Blocked / waiting on owner

- Headless `hold` semantics (also Pi, which has no "ask") — needed before the Pi adapter.
- Confirm spec default thresholds/budget for the pilot.
- Name check on PyPI and `.dev` (npm is free).
