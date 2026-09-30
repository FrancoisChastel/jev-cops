# @jev-cops/openshell

The OpenShell compiler and CLI wrapper for jev-cops (spec §OpenShell complement, PLAN-M2
steps 1–2). It turns what the judge knows (the harness, its config trees, the loaded
policies, the repo and the task) into one [NVIDIA OpenShell](https://github.com/NVIDIA/OpenShell)
sandbox policy, so the kernel and the proxy enforce what a hook cannot guarantee. It also
drives the `openshell` binary to create sandboxes and apply the task's hosts.

Everything here was written against **OpenShell v0.1.2** (repo `main` at `7caff12`,
2026-09-30). Code comments cite the files and lines each field, flag and JSON shape comes
from (`schema.mdx:<line>`, `main.rs:<line>`, …). When OpenShell changes, those citations
are what to re-check.

## The allow-only model

OpenShell has no host, path or binary deny: "OpenShell denies anything the policy does not
allow". A deny in jev-cops's sense becomes something the policy leaves out, and the
compiler reports each omission with its reason (`absent`).

| Spec deny fragment | OpenShell construct |
|---|---|
| host deny | the host is in no rule (default deny); judge provider hosts are asserted absent (T13) |
| path deny | the path is unlisted (inaccessible), or listed `read_only` outside every `read_write` root |
| binary deny | the binary is in no rule's `binaries` (the judge route lists only the hook) |
| method/path deny on an allowed host | `deny_rules` on a `rest` + `enforce` endpoint; no starter policy needs one |

Which starter policies produce what (D-106, `findings.ts`):

| Policy | Fragment | Why |
|---|---|---|
| `exfil-after-secrets` | task allowlist (network) | every host outside it is denied by default |
| `config-tamper` | protection set (filesystem) | harness config read-only, other config and `~/.jev-cops` unlisted |
| `tainted-destructive` | none | taint is not visible to the kernel or the proxy |
| `default-branch-guard` | none | the pushed branch is inside the `git-receive-pack` body; a deny on it would block every push |
| `off-repo-write`, `opaque-exec` | none | not deny-class; the workspace `read_write` limit bounds writes anyway |

## What is compiled

`compilePolicy(input)` is pure: it reads no file, runs nothing and never throws. It returns
the policy (or `null` when refused), deterministic YAML, the `policy update` calls for the
task's hosts, and a report.

- **Protection set** (`filesystem_policy`, `landlock`, `process`). Derived from
  `config-tamper`'s trees in `policies/_lib/config-trees.ts`, not from a second list. The
  harness's own kill- and hold-tier config (for Claude Code, `~/.claude` with
  `settings.json`, `settings.local.json`, `hooks/` and `plugins/`, plus
  `/etc/claude-code`) is `read_only`. The data the harness must write (`~/.claude/projects`,
  `plans`, `todos`, `~/.claude.json`, caches; for Pi, `~/.pi/agent/sessions`), the workspace
  and OpenShell's baseline writable paths are `read_write`. Every other harness's config
  and `~/.jev-cops` (the judge's records and keys) are unlisted, so they cannot be read.
  The hook binary and the Pi extension sit in read-only directories. The OpenShell baseline
  is repeated so a later `policy set` never drops it. `landlock.compatibility` is
  `hard_requirement`.
- **Judge route** (`jev_cops_judge`). `host.openshell.internal` on copsd's sandbox listener
  port, `rest` + `enforce`. It allows only the four routes the adapter calls (Claude Code:
  `POST /v1/judge|observe|session`, `GET /v1/explain/*`; Pi: `resolve` instead of `session`)
  and lists one binary: `cops-hook`, or the node interpreter for Pi. No Unix socket is
  mounted.
- **Task allowlist** (`jev_cops_task_registries|remote|hosts`). Registries come from the
  repo's lockfiles, with exact hosts: `registry.npmjs.org` (with `allow_encoded_slash`),
  `pypi.org` and `files.pythonhosted.org`, and so on. The git remote gets
  `https` → `read-write` rest, or `ssh` → `protocol: tcp` + `tls: skip`. Hosts named in the
  task get `read-only` rest. The binaries are the agent's executables.
- **T13.** `api.typesafe.ai`, `openrouter.ai` and any `--judge-host` never appear in a rule,
  whatever names them. The finished policy is asserted to have no endpoint that can reach
  one of them or a name under it.

## Refusals

A refusal means no policy at all, never a weaker one. The compiler refuses when:

- a kill-tier path (from `config-tamper`'s trees, the adapter's files or the protected
  paths) is `read_write`, or sits under a `read_write` root. Landlock grants and never
  revokes, so a `read_only` entry under a writable parent stays writable;
- HOME is inside the workspace;
- a listed path contains or lies inside `~/.jev-cops` or another private path;
- a path is relative, contains `..`, is over 4096 bytes, or `read_write` is `/`;
- there are more than 256 paths;
- the assembled policy fails the schema mirror;
- an endpoint reaches a judge provider host (T13).

These are printed as gaps, not refused, because the kernel cannot close them:

- `~/.claude.json` must stay writable (Claude Code rewrites it);
- project config inside the writable workspace (`.claude/settings.json`, `.cops.toml`, …)
  cannot be carved out of it. `config-tamper` keeps both kill tier, and Claude Code's hook
  is installed managed under `/etc/claude-code`.

## Run it

```sh
# print the policy (report on stderr); exit 1 when refused
cops openshell compile --harness claude-code --repo . --task "Fix the flaky test"

# jev-cops's own dry run (openshell policy set has none): diff, write nothing, exit 3 on changes
cops openshell compile --out policy.yaml
cops openshell compile --dry-run --out policy.yaml

# what `create` would run; it runs only with openshell on PATH and no --dry-run
cops openshell create demo --harness claude-code --from claude-agent:local --dry-run

# at the first prompt: add the task's hosts (policy update --wait), then check Loaded
cops openshell apply demo --task "Use https://docs.stripe.com" --dry-run
```

The layout flags (`--home`, `--workspace`, `--agent-binary`, `--hook-binary`,
`--interpreter`, `--extension`) take paths inside the sandbox. The defaults are those of the
step-9 images: HOME `/home/agent`, workspace `/sandbox`, `cops-hook` under
`/usr/local/libexec/jev-cops/`. Landlock skips paths that do not exist, so the image must
create the writable data directories beforehand.

## The wrapper

`openShellCli` runs the `openshell` binary from an absolute path. It uses argv arrays and an
environment built from scratch: HOME, the absolute entries of PATH, `NO_COLOR`, no browser
login, and the configured gateway and workspace. It never inherits
`OPENSHELL_SANDBOX_POLICY` or `OPENSHELL_GATEWAY_INSECURE`. Every call has a deadline and is
killed with SIGKILL when it runs over. `--wait` exits are mapped as documented: 0 means
applied, 1 rejected, 124 timed out. After an apply, the wrapper checks that the latest
`policy list` revision is `loaded`. `sandbox.ts` creates sandboxes with
`--no-auto-providers --approval-mode manual` and then pins the advisor settings. If that
fails, it stops the sandbox.

`testing/fake-openshell.ts` is the fake binary for tests. It records each call's argv and
environment, answers with canned JSON and exit codes 0, 1 or 124 (optionally after a
delay), and rejects a `--policy` file that the schema mirror rejects.

## Goldens and the prover

`goldens/*.yaml` and `*.report.txt` are compared byte for byte. The scenarios in
`goldens/scenarios.ts` are: Claude Code with npm and a GitHub remote, a baseline, task
hosts with an ssh remote, Pi with PyPI, T13 judge hosts, and a refused layout. After a
reviewed change, regenerate them with
`JEV_COPS_UPDATE_GOLDENS=1 bun test packages/openshell`. When `openshell-prover` is on PATH,
each golden is also checked with `openshell-prover check --boundary` against a boundary
built from it (same paths, no judge-host endpoint, `hard_requirement`). Without the prover,
the test prints `prover not installed: boundary check skipped`.
