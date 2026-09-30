# jev-cops

*The cops for your coding agents. They don't lock anyone up (that's the sandbox's job),
but they watch every move, write it all down, and call for backup when it matters.*

**A harness-side judge for coding agents.** jev-cops scores every agent tool call in its
context — who typed the arguments, does the action serve the declared task, what
happened just before, how exposed is the target, can it be undone — and returns a
graduated verdict: `allow · annotate · rewrite · hold · deny · kill`.

The same `git push --force` is allowed on a feature branch the user asked about, held
on the default branch, and denied in a headless session. What changes is the context,
not the command string.

> **Status: M0 and M1 complete** (M1 in gate review). Works today with **Pi** and **Claude
> Code**: the hook blocks, rewrites and asks, verified against the real `pi` and `claude`
> binaries ([Pi capture](docs/captures/pi-m0.md), [Claude Code capture](docs/captures/claude-code-m1.md)).
> `cops install` wires it up and `cops doctor` proves it fires. Next: OpenShell hard
> enforcement (M2), Codex and OpenCode (M3). Not production-ready yet: see
> [docs/STATUS.md](docs/STATUS.md).

## How it works

```text
harness ──pre-tool event──▶ adapter ──canonical JSON──▶ copsd
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
- **Audit trail.** Append-only JSONL with a hash chain; `cops explain <event-id>` shows
  the features, policies and answers behind any verdict.

jev-cops is not a sandbox and not the last line of defence. Anything that must never
happen belongs to a kernel-enforced policy such as [OpenShell](https://github.com/NVIDIA/openshell);
jev-cops compiles its hard findings down to it.

## Quickstart

Requires [Bun](https://bun.sh) ≥ 1.3. Node is not a supported runtime.

```bash
git clone https://github.com/FrancoisChastel/jev-cops && cd jev-cops
bun install
bun run check          # lint + typecheck + ~3000 tests
bun run gate           # cops test: every starter policy against its fixtures
bun run build          # dist/copsd, dist/cops, dist/cops-hook (WASM grammar embedded)
```

Run the judge and ask it about a tool call:

```bash
./dist/copsd --enforce --socket /tmp/copsd.sock      # default mode is observe
curl -s --unix-socket /tmp/copsd.sock -X POST http://localhost/v1/judge \
  -H 'content-type: application/json' --data @tests/fixtures/events/pre-bash.json
./dist/cops explain <event-id> --audit ~/.jev-cops/audit.jsonl
```

Configuration lives in `~/.config/jev-cops/cops.toml` (see `packages/daemon/src/config.ts`
for every key and default); a repo-local `.cops.toml` may only tighten it. Judge API keys
are read from the environment only (`.env.example`).

### Install for Claude Code / Pi

Start the daemon, register jev-cops with the harness, then check the whole chain:

```bash
./dist/copsd --enforce &                     # while copsd is down the hook blocks non-read calls
./dist/cops install claude-code --dry-run    # the settings diff, nothing written
./dist/cops install claude-code              # ~/.claude/settings.json; --project, --local, --managed
./dist/cops install pi                       # ~/.pi/agent/extensions/jev-cops.ts; --project
./dist/cops doctor                           # read-only: daemon, audit chain, hooks, canary, gaps
```

`cops install claude-code` merges the hook into Claude Code's settings (with a backup),
refuses on a bare `Bash` allow rule (the spec's rule) or `disableAllHooks` (`--force`
overrides), records the hook binary in `cops.toml`, and runs a canary through the installed
hook. Both installers print every known gap, and `--uninstall` removes only what they
added. `cops doctor` checks copsd on both sockets, the audit chain, each harness's install
(hook in force on every event, binary, socket, risky settings, workspace trust), runs the
same canary through the registered hook, and prints every gap it cannot close; it exits 1
on any failure. Details: [adapters/claude-code/README.md](adapters/claude-code/README.md),
[adapters/pi/README.md](adapters/pi/README.md).

## Writing a policy

Policies are TypeScript in a git-tracked `policies/` directory. Deterministic prefilter
first, typed questions only when needed, code returns the verdict:

```ts
import { definePolicy, jev } from "@jev-cops/sdk";

export default definePolicy({
  name: "exfil-after-secrets",
  version: 3,
  owner: "cyber-team",
  when: (e, ctx) =>
    e.call.kind === "net" && ctx.sequence.secretReadWithin("2m") && !ctx.scope.hostAllowed(e.net.host),
  ask: (e, ctx) => [
    jev.noul("dest_fits_task", `The destination ${e.net.host} is a service the task plausibly needs: ${ctx.session.task}`),
  ],
  decide: (_e, _ctx, a) => (a.dest_fits_task.p < 0.4 ? "deny" : a.dest_fits_task.p < 0.8 ? "hold" : "annotate"),
  reason: "Network call to a new host shortly after reading a secret.",
});
```

Every policy ships with a `*.fixtures.json`; `cops test` fails on any mismatch. The
full author guide is [packages/sdk/README.md](packages/sdk/README.md); judge providers are
described in [packages/judge/README.md](packages/judge/README.md).

## Repository layout

```text
packages/core       event schema, normalizer, context engine, judge interface, policy engine
packages/sdk        definePolicy, question builders, fixture runner  (@jev-cops/sdk)
packages/judge      semantic judge providers: TypeSafe Jev, OpenRouter, Vercel AI SDK
packages/daemon     copsd: socket + loopback HTTP, SQLite stores, hash-chained audit log
packages/cli        cops test | explain | replay | budget | install | doctor | hook
adapters/           pi (M0) · claude-code command hook (M1) · codex, opencode (M3)
policies/           starter policy set, one *.fixtures.json per policy
tests/tamper        T1–T13 anti-tamper acceptance tests (see tests/tamper/README.md)
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
