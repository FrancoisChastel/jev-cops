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
| D-008 | 2026-09-29 | Headless `hold` (and `hold` on harnesses with no "ask", i.e. Pi) maps to `deny` with the verdict's `reason` | Owner decision from spec §Open decisions. A pause the harness cannot honour must not become an allow. |
| D-009 | 2026-09-29 | Pilot uses the spec's default thresholds: budget 100, decay 10/min, bands 0.3 / 0.5 / 0.8 | Owner decision from spec §Open decisions. Values live in one config module so a team override is a single edit. |
| D-010 | 2026-09-29 | Event schema is strict at every nesting level; only `call.input` accepts arbitrary keys, and it is returned as the same object reference (no zod `record`, which drops `__proto__`) | The daemon never accepts shapes it does not understand; `input` must be verbatim so the normalizer sees exactly what the harness will run. |
| D-011 | 2026-09-29 | `id` must be `evt_` + an upper-case 26-char ULID with first char 0–7; `session.id` / `call.id` / `parent_id` are `sess_`/`call_` + non-whitespace | Tight formats make forged or sloppy ids fail fast at the adapter boundary. |
| D-012 | 2026-09-29 | Verdict response: `updated_input` must be non-null iff `verdict === "rewrite"`; `detail` is optional; `stdout_head` 4 KB bound is documented but not enforced by the schema (adapter responsibility) | A rewrite without a payload or a payload without a rewrite is a bug; `detail` may be stripped before the response reaches an adapter. |
