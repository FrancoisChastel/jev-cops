# Jevdict

**A harness-side judge for coding agents.** Jevdict scores every agent tool call in its
context — who typed the arguments, does the action serve the declared task, what
happened just before, how exposed is the target, can it be undone — and returns a
graduated verdict: `allow · annotate · rewrite · hold · deny · kill`.

The same `git push --force` is allowed on a feature branch the user asked about, held
on the default branch, and denied in a headless session. What changes is the context,
not the command string.

> **Status: M0 in progress.** Core schema, normalizer and context engine are being
> built; no adapter is usable yet. See [docs/STATUS.md](docs/STATUS.md).

## How it works

```text
harness ──pre-tool event──▶ adapter ──canonical JSON──▶ jevdictd
                                                          │  1. normalize  (tree-sitter-bash, decode, expand, resolve)
                                                          │  2. context    (taint · scope · sequence · environment · reversibility)
                                                          │  3. policies   (deterministic floor, then typed questions to a judge)
                                                          │  4. verdict    (monotonic: code decides, the model can only raise)
harness ◀──allow/deny/rewrite/ask── adapter ◀─verdict────┘
```

- **Observe by default.** Nothing is blocked unless a policy says so.
- **Code owns the verdict.** Deterministic features set a floor; a model answer can raise
  risk without limit but lower it by at most 0.2, and never turns a `deny` into `allow`.
- **Fail closed where it matters.** A daemon timeout is a `deny` for deny-class policies,
  never an allow. Observe-only events log and continue.
- **Pluggable semantic judge.** TypeSafe Jev, OpenRouter, or any Vercel AI SDK provider,
  all behind one typed interface and mocked in tests. Off by default.
- **Thin adapters.** Claude Code, Codex, OpenCode, Pi — each under 150 lines, zero policy logic.
- **Audit trail.** Append-only JSONL with a hash chain; `jevdict explain <event-id>` shows
  the features, policies and answers behind any verdict.

Jevdict is not a sandbox and not the last line of defence. Anything that must never
happen belongs to a kernel-enforced policy such as [OpenShell](https://github.com/NVIDIA/openshell);
Jevdict compiles its hard findings down to it.

## Quickstart (developers, today)

```bash
git clone https://github.com/FrancoisChastel/jevdict && cd jevdict
bun install
bun run check          # lint + typecheck + tests
```

Requires [Bun](https://bun.sh) ≥ 1.3. Node is not a supported runtime.

## Quickstart (users, once M0 ships)

```bash
bun add -g jevdict
jevdict install pi           # writes the Pi extension, prints known gaps
jevdictd                     # start the judge on a Unix socket
jevdict doctor               # canary tool call: proves the hook fires and blocks
```

## Writing a policy

Policies are TypeScript in a git-tracked `policies/` directory. Deterministic prefilter
first, typed questions only when needed, code returns the verdict:

```ts
import { definePolicy, jev } from "@jevdict/sdk";

export default definePolicy({
  name: "exfil-after-secrets",
  version: 3,
  owner: "cyber-team",
  when: (e, ctx) =>
    e.call.kind === "net" && ctx.sequence.secretReadWithin("2m") && !ctx.scope.hostAllowed(e.net.host),
  ask: (e, ctx) => [
    jev.noul("dest_fits_task", `The destination ${e.net.host} is a service the task plausibly needs: ${ctx.session.task}`),
  ],
  decide: (e, ctx, a) => (a.dest_fits_task.p < 0.4 ? "deny" : a.dest_fits_task.p < 0.8 ? "hold" : "annotate"),
  reason: "Network call to a new host shortly after reading a secret.",
});
```

Every policy ships with a `*.fixtures.json`; `jevdict test` fails on any mismatch.

## Repository layout

```text
packages/core       event schema, normalizer, context engine, policy engine, verdict ladder
packages/sdk        definePolicy, question builders, fixture helpers  (@jevdict/sdk)
packages/daemon     jevdictd: socket + HTTP, stores, audit log, judge client
packages/openshell  policy compiler → OpenShell YAML
packages/cli        jevdict install | doctor | test | replay | explain | budget
adapters/           claude-code · codex · opencode · pi
policies/           starter policy set with fixtures
tests/tamper        T1–T13 anti-tamper acceptance tests
docs/               SPEC.md (source of truth), PLAN-M0.md, DECISIONS.md, STATUS.md, adapters.md
```

## Documentation

- [Spec](docs/SPEC.md) — architecture, context model, verdict ladder, policy DSL, threat model
- [M0 plan](docs/PLAN-M0.md) — modules, interfaces, test list
- [Decisions](docs/DECISIONS.md) — choices the spec left open
- [Status](docs/STATUS.md) — done / next / blocked
- [Contributing](CONTRIBUTING.md) · [Security policy](SECURITY.md)

## License

[Apache-2.0](LICENSE)
