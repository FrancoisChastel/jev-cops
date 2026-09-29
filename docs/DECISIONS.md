# Decisions

Choices made while building that the spec leaves open **and** that are not in the
spec's "Open decisions" list (those are asked, not decided). Each entry names the
safer option taken and why. Reverse any of them by editing the code and this file.

| ID | Date | Decision | Why it is the safer option |
|---|---|---|---|
| D-001 | 2026-09-29 | License: Apache-2.0 | Explicit patent grant and contribution terms; standard for security tooling. Swap to MIT is a one-file change if preferred. |
| D-002 | 2026-09-29 | Noul `confidence` is derived as `abs(2p − 1)` | The TypeSafe SDK (`@typesafe-ai/sdk@0.6.0`) returns `{ noul: p }` with no confidence field, but the spec's confidence routing needs one for every answer type. `abs(2p−1)` is 0 at p=0.5 (max uncertainty, answer discarded) and 1 at the extremes; it can only make routing stricter. |
| D-003 | 2026-09-29 | `$HOME`/`~` expansion uses a `home` value from daemon config (default `os.homedir()` of the daemon host), never from the event | The event schema has no home field and adapters must not add one; trusting an agent-supplied home would let it steer path normalization. |
| D-004 | 2026-09-29 | Semantic judge is provider-pluggable behind one `Judge` interface: `mock`, `jev`, `openrouter`, `vercel-ai` | Requested by the owner mid-build (spec extension). Core and policies depend only on the interface; the monotonic floor, confidence routing, timeout and cache rules apply identically to every provider. LLM providers answer the same typed questions via structured output; their self-reported confidence is treated exactly like Jev's, and the deterministic floor is what limits damage from a badly calibrated provider. |
| D-005 | 2026-09-29 | Parse failures in the bash normalizer never throw; the whole command becomes one `opaque` span with `reason: "parse-error"` and `kind: "exec"` | An unparseable command must be scored like an unknown exec, not skipped. |
| D-006 | 2026-09-29 | Spec repo layout kept; the spec itself lives at `docs/SPEC.md` | The handoff file was dropped at the repo root; the spec's own layout section names `docs/`. |
| D-007 | 2026-09-29 | Bun is pinned via `packageManager` and CI; Node is not a supported runtime for the daemon | `bun:sqlite` and `bun build --compile` are hard dependencies per the spec's tech choices. |
