# M2 plan — OpenShell compiler, JIT grants, audit off-box, T1–T13 on Pi and Claude Code

Source of truth: [SPEC.md](./SPEC.md). M2 definition of done (spec §Milestones):
"T1 to T13 in `tests/tamper` passing on Pi and Claude Code, OpenShell compiler with fixtures,
JIT grants with TTL, audit log hash chain verified by `jevdict doctor`." Gate: the M2 subset
of `tests/tamper` green in CI (deterministic parts) and the gated live run captured.

Docs re-read on 2026-09-30 (ground rule: docs win over the spec). NVIDIA OpenShell is at
**v0.1.2** (released 2026-09-28; `main` at `7caff12`, 2026-09-30). Sources, cloned into
`/private/tmp/claude-501/m2-plan/openshell/`: `README.md`, `docs/about/{overview,architecture,
installation,support-matrix,run-your-first-agent}.mdx`, `docs/how-it-works/policies/{overview,
schema,network-rules,manage-policies,default-policy,advisor,prover}.mdx`,
`docs/how-it-works/sandboxes/{overview,runtimes,templates}.mdx`, `docs/how-it-works/gateways/
configuration.mdx`, `docs/security/best-practices.mdx`, `docs/observability/{logging,
ocsf-json-export,accessing-logs}.mdx`, `docs/tutorials/{first-network-policy,
run-pi-with-openrouter}.mdx`, `docs/upgrade/0-1-0.mdx`, `crates/openshell-cli/src/main.rs`
(the clap definitions of `openshell policy set|update|get`, `sandbox create`), `providers/
claude-code.yaml`, the v0.1.2 release assets; the Linux kernel's `Documentation/userspace-api/
landlock.rst` (`torvalds/linux` master); Codex `docs/execpolicy.md` → `developers.openai.com/
codex/exec-policy.md`. Quotes below are verbatim. The published docs live at
`https://docs.nvidia.com/openshell/latest/…` (the spec's `nvidia.github.io/OpenShell/
pr-preview/pr-259/sandboxes/index.html` still answers 200 as a stale preview; the site root
`nvidia.github.io/OpenShell/` is 404).

Owner decisions recorded before this plan: the audit destination question of spec §Open
decisions is answered (2026-09-30): keep the local append-only JSONL, add a **syslog forwarder**
(RFC 5424 over TCP with TLS) behind a pluggable forwarder interface; sign **checkpoints with an
Ed25519 key** kept outside the sandbox, the cyber team holds the public key, `cops doctor` and
the team verify chain + signatures. §6 designs it; §10 has no open question left.

## 1. Definition of done and gate

| Item (spec §Milestones M2) | Planned as |
|---|---|
| OpenShell compiler with fixtures | `packages/openshell`: `compile.ts` turns the loaded policy set, the daemon's protected/private paths and the task-derived allowlist into one OpenShell policy YAML (schema `version: 1`) plus incremental `openshell policy update` operations; golden-YAML fixtures; a zod mirror of the documented schema; `openshell-prover` boundary checks when the prover binary is present; jev-cops's own `--dry-run` diff (OpenShell's `policy set` has none, §2 row 7) |
| JIT grants with TTL | network grants only (filesystem rules are startup-only, §2 row 4): a new `jev_cops_jit_<n>` rule per grant through `openshell policy update … --wait`, TTL 30 min capped at session end, revoked by timer, session end, GC and boot reconcile; granted by Pi's in-sandbox resolve **only when no sandbox is involved** (M1 behaviour) and by `cops grant <event-id>` on the admin socket under OpenShell (§5, D-110/D-111) |
| Audit chain verified by doctor | `checkpoint` lines signed with Ed25519 every N lines and at session end/boot/shutdown; syslog forwarder (RFC 5424/5425) behind `AuditForwarder`; `cops audit verify` and `cops doctor` verify chain, signatures and the local copy against the off-box copy (§6) |
| T1–T13 on Pi and Claude Code | every OpenShell-dependent row split in two: a **deterministic part in CI** (the compiled fragment contains the rule that blocks the action; a fake `openshell` binary records what the daemon would apply) and a **gated live part** (`JEV_COPS_OPENSHELL_LIVE=1`, a real gateway on this machine's Docker Desktop, §9) |

**Gate:** `bun test tests/tamper` green with these rows live: T1 (OpenShell part, deterministic:
the emitted policy lists every kill-tier config path as `read_only` and none of them under a
`read_write` root, the prover boundary passes; live: a write inside the sandbox fails at the
kernel), T4 (deterministic: the fragment denies the same host/binary a `permissions.allow`
bypass would reach; live: OCSF `DENIED` line), T7 (JIT grant time-boxed and revoked; a self-posted
judge on the sandbox listener grants nothing), T12 (forwarder, signed checkpoints, `cops doctor`
alert on tail truncation against the off-box copy), T13 (the emitted policy has no endpoint for
any judge provider host; the judge rule lists only the hook binary and four paths; live: the
provider host is unreachable from the sandbox and reachable from copsd). Plus `bun run gate`
(6 policies, unchanged results after step 0) and a captured live run in
`docs/captures/openshell-m2.md`. What "passing on Pi and Claude Code" means when a test needs
a kernel: both harnesses share the same compiled fragments and the same fake-`openshell`
integration; the live run exercises Claude Code (the primary target) and Pi once each.

**Can OpenShell run on this machine?** Yes, through Docker Desktop, with one prerequisite. The
support matrix lists "macOS (Docker Desktop) | Apple Silicon (arm64) | Supported" and says "On
macOS, these kernel modules run inside the Docker Desktop Linux VM, not on the host kernel."
Measured here: Docker Desktop **29.4.3** (engine 29.4.3, linux/arm64, cgroup v2; the matrix
needs "Docker Desktop or Docker Engine 28.0 or later"), kernel **6.12.76-linuxkit** with
`CONFIG_SECURITY_LANDLOCK=y`, `CONFIG_LSM="…,bpf,landlock"`, `CONFIG_SECCOMP_FILTER=y` — Landlock
ABI ≥ 3 ("introduced in Linux 6.2") and `WAIT_KILLABLE_RECV` (5.19+) are both there. The
prerequisite is not met today: runtimes.mdx says "Docker Desktop must have host networking
enabled, and it cannot use Enhanced Container Isolation", and a probe (`--network host`
container listening on 18099, `curl 127.0.0.1:18099` from macOS) showed host networking **off**
(the container saw the VM's `192.168.65.x` interfaces; the port was not reachable from the
Mac). Enabling it is a Docker Desktop setting (Resources → Network); ECI is a Business feature
not readable from this sandbox, to be confirmed at the same time. Alternative without Docker:
the MicroVM driver ("Hypervisor.framework on macOS", `compute_driver = "vm"`, never
auto-detected). No `openshell` is installed; the Homebrew installer script puts a gateway
service at `https://localhost:17670`. Everything the sandbox runs must be `linux/arm64`
(`bun build --compile --target=bun-linux-arm64` for `cops-hook`).

## 2. Docs-vs-spec differences (OpenShell)

"Spec" is `docs/SPEC.md` (2026-09-29); "docs" is OpenShell v0.1.2 / `main` on 2026-09-30.

| # | Fact | Spec says | Docs say today (source, quote) | Consequence |
|---|---|---|---|---|
| 1 | Deny primitives | step 2: "a deterministic fragment where one exists: a host deny, a path deny, a binary deny" | policies/overview: "OpenShell denies anything the policy does not allow." schema: `filesystem_policy` has only `read_only` and `read_write` ("Paths that are not listed are inaccessible"); `network_policies` are allow rules with `binaries` ("An empty list matches no binary"); `deny_rules` exist only inside an inspected endpoint ("Deny rules, which take precedence over allow rules", REST/WebSocket/GraphQL/MCP matchers). | There is no host, path or binary *deny*. A "deny fragment" is an omission from the allowlist, plus L7 `deny_rules` on hosts we do allow. The compiler emits allowlists and asserts what is absent (D-106). |
| 2 | Landlock is grant-only | "marks the four harness config directories … as read-only" | landlock.rst §Layers of file path access rights: "One policy layer grants access to a file path if at least one of its rules encountered on the path grants the access." best-practices: "Paths listed in `read_write` receive full access." | A `read_only` entry under a `read_write` ancestor (a repo's `.claude/`, a `~/.claude/` under a writable home) stays writable. Protected dirs must sit outside every writable tree; the compiler refuses otherwise (D-106, D-107). Project-level `.claude/settings.json` inside a writable repo cannot be kernel-protected: the hook is installed as **managed** under `/etc` (read-only baseline) so nothing in the repo can remove it. |
| 3 | Filesystem rules are fixed at start | step 3 JIT grants "when a hold is resolved with allow and the action needs new network or filesystem access" | manage-policies#how-changes-take-effect: "Added filesystem paths: The saved policy can change, but the running workload keeps its existing filesystem permissions. Recreate the sandbox."; "Removed filesystem paths, or changed `include_workdir`, Landlock, or process settings: OpenShell rejects the change after the workload starts." overview table: `filesystem_policy` "Takes effect: At sandbox startup." | JIT grants are network-only in M2 (D-110). A hold on a filesystem action resolved allow runs the tool; a path outside the policy fails at the kernel and shows in the post event. |
| 4 | Network rules hot-reload | step 1 "applies them with `openshell policy set <sandbox> --policy <file>`" | overview: `network_policies` "Takes effect: While the sandbox runs." manage-policies: "When new network rules take effect, OpenShell closes connections that were opened under the previous rules, including HTTP keep-alive connections". `openshell policy update` "changes only the `network_policies` section"; `policy set` "replaces the whole policy … start from the current base policy". | Task allowlists and JIT grants go through `policy update` (incremental, no need to carry the enriched base). `policy set` is used only at creation-time repair. Every apply closes the agent's open connections: apply at the first prompt, not mid-call. |
| 5 | `--wait` semantics | — | manage-policies#verify-a-change: "With `--wait`, the CLI also waits for the sandbox to report a result. It exits with status `1` if the sandbox rejects the revision, and with status `124` if the wait times out."; "A successful exit does not always mean your change is active." | The wrapper always passes `--wait --timeout 20`, then reads `policy list` for `Loaded`; 1/124 are apply failures (§8). |
| 6 | Policy validation failure mode | — | configuration: `policy_validation_failure_mode` "The default, `fail_closed`, deactivates the previous network policy … and denies new egress until a valid generation loads." | A rejected revision blacks out the sandbox's network: the compiler validates locally first (schema mirror, prover) so a bad YAML never reaches the gateway. |
| 7 | `--dry-run` | step 4: the compiler "runs with `--dry-run` in CI and prints the diff" | main.rs `PolicyCommands::Set` has `--policy`, `--global`, `--yes`, `--wait`, `--timeout` and **no `--dry-run`**; `Update` has `dry_run` ("Preview the merged policy without sending it to the gateway"). | `cops openshell compile --dry-run` is jev-cops's: compile locally, diff against `openshell policy get --base --output json | jq .policy` when a gateway is reachable, else against the golden fixture; exit 3 when there are changes (D-108). |
| 8 | The mounted socket | "The sandbox reaches it only through one mounted Unix socket" | runtimes#docker-mounts: "Bind mounts expose gateway-host files to the sandbox and can bypass workspace isolation and filesystem policy. They require `enable_bind_mounts = true` and disabling resource admission". schema: "Network policy never authorizes an outbound endpoint whose destination is loopback … A rule for `host.openshell.internal` can still reach services on the gateway host." architecture: the supervisor "opens approved connections and relays traffic". | No Unix socket mount. The hook reaches copsd's loopback HTTP listener through the supervisor at `http.host.openshell.internal:<port>` under a `jev_cops_judge` rule listing only the hook binary (D-105). Docker: "Docker Desktop must have host networking enabled". |
| 9 | Binary identity and inheritance | "the agent cannot signal or restart it" (daemon); "adapter binary as read-only" | network-rules#binary-matching: "A rule also applies to processes that a listed binary starts."; "OpenShell records a hash of each executable the first time it takes part in a connection, and denies later connections if the file at that path changes." best-practices: "Command-line paths remain diagnostic context and never authorize access." | Claude Code: a rule for `cops-hook` does not extend to `claude`'s other children (they are not cops-hook's descendants), so the agent's `curl` has no route to copsd; a replaced hook loses its route (hash pin). Pi: the extension runs inside `node`, so every tool Pi spawns inherits node's rule — the socket cannot be kept from Pi's tools by OpenShell alone (D-111). |
| 10 | `kill` stops the sandbox | verdict table: "Deny plus session terminated and OpenShell sandbox stopped" | sandboxes/overview#stop-and-start-sandboxes: "`openshell sandbox stop my-sandbox` … stops local background forwards and waits for the `Stopped` phase. … While stopped, you cannot connect, execute commands". | copsd runs `openshell sandbox stop <name>` after latching a `kill` (D-112): the process residual of PLAN-M1 §5 row 13 is closed for sandboxed sessions. |
| 11 | Policy precedence and the global policy | — | policies/overview: global > "The sandbox's saved policy. At creation, `--policy` takes precedence over `OPENSHELL_SANDBOX_POLICY`" > image `/etc/openshell/policy.yaml` > default; "While [a global policy] is active, OpenShell blocks sandbox policy changes and proposal approvals". | jev-cops applies per-sandbox policies; a global policy makes every apply fail → §8 row 3 (net events held). |
| 12 | Baseline paths | "the `policies/` directory … read-only" | default-policy#baseline-filesystem-paths: with any network rule OpenShell adds `/usr, /lib, /etc, /app, /var/log, /proc, /dev/urandom` read-only and `/tmp, /dev/null` read-write; "`/.openshell` … cannot expose". schema: "A policy can list at most 256 paths", "`read_write` cannot contain `/`", "must not contain `..`". | `policies/` is on the host, never in the sandbox: nothing to protect there. The image's `/etc/claude-code/managed-settings.d/50-jev-cops.json` is read-only by the baseline. The compiler counts paths (≤ 256) and rejects `..`. |
| 13 | Advisor and auto-approval | — | advisor: "OpenShell also drafts proposals on its own from connections that it blocks, in every sandbox"; automatic mode "approves such proposals, including OpenShell's own drafts from blocked connections, so turn it on only if you accept that binaries in the sandbox can gain access to public hosts without your review." | `cops openshell create` sets `agent_policy_proposals_enabled=false`, `proposal_approval_mode=manual`; doctor fails when auto-approval is on for the judged sandbox (D-119): otherwise an exfil host could be self-granted around the judge. |
| 14 | Prover | — | prover: "`openshell-prover check candidate.yaml --boundary boundary.yaml`"; "result: within_boundary / coverage: domains=filesystem,network_l4,network_rest,process,landlock"; v0.1.2 ships `openshell-prover-aarch64-apple-darwin.tar.gz`. | A deterministic, gateway-free check for CI and this Mac: the emitted policy must stay within `boundary/no-judge-hosts.yaml` and `boundary/config-read-only.yaml` (T13, T1). |
| 15 | Logs | T1/T4 "the write also fails at the kernel" | logging: OCSF shorthand `NET:OPEN [MED] DENIED /usr/bin/curl(64) -> api.github.com:443 [policy:- engine:opa] [reason:…]`; proxy answers `403` `{"error":"policy_denied", …}`; `openshell logs <name> --source sandbox`; Landlock denials are `EACCES` in the workload, startup logs `Landlock ruleset built [rules_applied:5 skipped:1]`. | The live tests assert these lines; the post event of a kernel-denied tool shows `EACCES`/`policy_denied` in `stdout_head`. |
| 16 | Landlock best effort | — | schema#landlock: `best_effort` "The sandbox runs without the filesystem rules and logs a high-severity finding"; `hard_requirement` "The sandbox fails to start." | The compiler emits `landlock: { compatibility: hard_requirement }` (D-106): a kernel that cannot enforce the protection set does not run the agent. |
| 17 | Images | — | sandboxes/overview: "`--from` does not expand catalog aliases and does not build local Dockerfiles"; default image "does not bundle agent CLIs"; run-pi tutorial builds `pi-agent:local` from `node:24-bookworm-slim` with `PI_CODING_AGENT_DIR=/tmp/pi-agent`. providers/claude-code.yaml allows `api.anthropic.com`, `statsig.anthropic.com`, `sentry.io` for `binaries: [/usr/bin/claude, /usr/local/bin/claude]`. | The live step builds its own image (`docker build`) with the harness, a `linux/arm64` `cops-hook` and the managed install; the model endpoint comes from a provider profile (rules keyed `_provider_*`, which the compiler never touches). |
| 18 | Docker on macOS | "laptops … where OpenShell is not yet deployed" | runtimes#docker-driver: "Docker Desktop must have host networking enabled, and it cannot use Enhanced Container Isolation. Set `grpc_endpoint` when sandboxes cannot reach the gateway on host loopback." | Prerequisite for the live step (§1); host networking is off here today. |
| 19 | Codex execpolicy (M3, note only) | "`.codex/rules` execpolicy prefix rules generated by the OpenShell compiler" | codex/exec-policy: "Rules are experimental and may change."; `.rules` files under `rules/` next to a config layer (`~/.codex/rules/default.rules`; `<repo>/.codex/rules/` "load only when the project `.codex/` layer is trusted"); `prefix_rule(pattern=[…], decision="allow"|"prompt"|"forbidden", justification, match, not_match)`; "Codex applies the most restrictive decision when more than one rule matches"; `bash -lc` linear chains are split with tree-sitter, anything else "is treated as … a single invocation". | The M3 emitter is a separate `codex/` module (Starlark-like text, not YAML); `forbidden`/`prompt` prefixes for the deny class. `config-tamper` already kills writes to `~/.codex/rules` (D-073). |

## 3. Build order with gates

| # | Module | Delivers | Gate |
|---|---|---|---|
| 0 | housekeeping: `policies/_lib/` + loader | core `loadPolicies` skips `_`-prefixed files (it already never recurses, D-037); `policies/_lib/config-trees.ts` (tier trees, placement, `pathTier`, markers), `policies/_lib/judge-guard.ts` (stop/private/CLI findings), `config-tamper.ts` ≤ 150 lines with `findings`, `reasonFor`, `definePolicy` only; `policies.test.ts` and `cops test` ignore `_lib` | `bun run gate` byte-identical (6 policies, 133 cases, 266 runs); a loader test that a `_lib/` dir and a `_shared.ts` are not policies; the daemon's `protectedPaths` still covers `policies/` whole |
| 1 | `packages/openshell` compiler | `schema.ts`, `emit.ts`, `fragments/*`, `compile.ts`, `diff.ts`, goldens, boundaries, `cops openshell compile [--dry-run]` | fixture tests: every golden byte-identical; schema mirror rejects the documented invalid shapes; prover check passes when the binary is present (skipped with a printed notice otherwise) |
| 2 | `openshell` CLI wrapper + fake | `cli.ts` (`OpenShellCli` over `Bun.spawn`, absolute binary, scrubbed env, deadlines, JSON parsing), `testing/fake-openshell.ts` (records argv, canned answers, exit 0/1/124), `sandbox.ts` (create/get/stop/logs/settings), `cops openshell apply|create` | wrapper tests against the fake: argv exactly as documented, `--wait` exit-code mapping, `policy list` Loaded check |
| 3 | daemon: sandbox listener, session-start apply, kill → stop | `[openshell]` config table; second loopback listener with surface `sandbox`; `derived.sandbox`; baseline at creation, task hosts at first prompt; apply failure → net events held; `openshell sandbox stop` after a kill latch | daemon tests with the fake `openshell`: apply argv per scenario, held-until-applied, global-policy refusal, stop on kill |
| 4 | JIT grants | `jit.ts` store (SQLite `jit_grants`), scheduler, `cops grant <event-id>`, sandbox-listener resolve = allow once, boot reconcile | T7 rows live (deterministic) |
| — | *(session boundary suggested: stop and report)* | | |
| 5 | audit: forwarder + checkpoints + verify | `AuditForwarder` interface, `file` (moved), `syslog` (RFC 5424/5425 over TLS), cursor/resume, `checkpoint` lines, `cops keygen`, `cops audit verify`, `/v1/health` forwarder status, doctor checks | T12 rows live against an in-test TLS syslog receiver |
| 6 | hook + Pi extension over HTTP; in-sandbox `env.git` | `cops-hook --url`, Pi `INSTALLED_URL`, sandbox detection (informational), hook-side git derivation (`derived.git.by: "hook"`), `config-tamper` additions (D-114) | adapter tests; e2e through the fake runners with `--url` |
| 7 | doctor + install | `openshell` doctor group (binary, gateway, sandbox phase, policy revision Loaded, advisor settings, JIT grants past expiry, forwarder lag, signing key/pubkey); installer/`cops openshell create` prints the sandbox posture; every new gap printed | doctor tests; `cops doctor --json` schema `jev-cops.doctor/1` unchanged in shape (new groups) |
| 8 | `tests/tamper` | T1, T4, T7, T12, T13 deterministic parts live; live parts `skipIf` gated | `bun test tests/tamper` |
| 9 | live run + docs | `scripts/openshell-live.sh`, image `docker/claude-code.Dockerfile` and `docker/pi.Dockerfile`, `docs/captures/openshell-m2.md`, `docs/adapters.md#openshell` (this §2 table + gaps), STATUS, DECISIONS D-103… | captured run reviewed; Docker Desktop host networking confirmed on |

Steps 1–2 need no daemon change and no OpenShell; steps 3–4 need only the fake binary. Step 5
is independent of OpenShell entirely and can land in parallel.

## 4. `packages/openshell` module map and interfaces

```text
packages/openshell/
  src/
    schema.ts          zod mirror of docs/how-it-works/policies/schema.mdx: version 1; filesystem_policy
                       {include_workdir?, read_only[], read_write[]}; landlock {compatibility}; process
                       {run_as_user?, run_as_group?}; network_policies map (key /^[a-z0-9_]+$/, not
                       `_provider_`); endpoint destination/inspection/credential fields; binary {path}.
                       Rules the docs state: absolute paths, no `..`, ≤ 4096 bytes, ≤ 256 paths,
                       `read_write` ≠ `/`; `port` xor `ports`; wildcard host ≥ 3 labels; `access` xor
                       `rules`; `protocol: tcp` takes no request fields; same host+port ⇒ same tls/allowed_ips.
    emit.ts            deterministic YAML (sorted keys, 2-space, quoted strings, `# backs: <policy@v>` comments)
    fragments/
      protection.ts    filesystem_policy + landlock for a harness layout (D-107)
      task-allowlist.ts  registries (read-only rest, allow_encoded_slash for npm), git remote
                       (https 443 read-write rest, or ssh 22 `protocol: tcp` + `tls: skip`), task hosts (read-only rest)
      judge-route.ts   `jev_cops_judge`: host.openshell.internal:<port>, rest, enforce, rules exactly
                       POST /v1/judge, /v1/observe, /v1/session, /v1/resolve; GET /v1/explain/*, /v1/budget/*;
                       binaries: the hook binary (Claude Code) or the node interpreter (Pi)
      jit.ts           one `jev_cops_jit_<n>` rule for a host:port grant (rest read-write, or tcp)
    compile.ts         compilePolicy(input) → { policy, fragments[], absent[] , refusals[] }
    diff.ts            structural diff of two policies (rules added/removed/changed, paths added/removed)
    cli.ts             OpenShellCli over Bun.spawn: policy get/list/update/set, sandbox create/get/stop/exec/logs, settings get/set
    sandbox.ts         create (with --policy, --no-auto-providers, --approval-mode manual, --env), readiness wait, posture checks
    boundary/          no-judge-hosts.yaml, config-read-only.yaml (prover boundaries)
    fixtures/          golden YAML per scenario (§9)
  testing/fake-openshell.ts   argv recorder + canned responses + exit codes; used by daemon and CLI tests
```

```ts
// compile.ts
interface CompileInput {
  harness: "claude-code" | "pi";
  layout: { home: string; workspace: string; hookBinary: string | null; agentBinaries: string[];
            interpreter: string | null };           // in-sandbox paths, from [openshell] (host-controlled)
  policies: readonly PolicyDefinition[];             // the daemon's loaded set (name, version, range)
  protectedPaths: readonly string[];                 // the daemon's, rewritten for the sandbox home
  task: string | null; repo: RepoHints | null;       // core taskAllowlist() inputs (registries, remote)
  judge: { port: number } | null;                    // the sandbox listener; null = no route (Pi/Claude in observe-only)
  extraReadWrite?: string[];                         // operator additions, validated like the rest
}
interface CompiledPolicy {
  policy: OpenShellPolicy;                           // full YAML for creation
  updates: PolicyUpdate[];                           // `policy update` argv for the live sections (network only)
  fragments: { name: string; backs: string[]; section: "filesystem" | "network" }[];
  absent: { host?: string; path?: string; why: string }[];   // what the policy deliberately does not allow (T13 hosts, provider hosts)
  refusals: string[];                                // e.g. "~/.claude is under read_write /home/agent (Landlock grants, never revokes)"
}
function compilePolicy(i: CompileInput): CompiledPolicy;   // pure; throws never; refusals non-empty ⇒ no policy
function policyFragmentsFor(p: PolicyDefinition): FragmentKind[];   // D-106 table below
```

Which starter policies emit which deterministic fragments (D-106; OpenShell is allow-only, so a
"deny" is what is left out, §2 row 1):

| Policy (range) | Fragment | Section |
|---|---|---|
| `exfil-after-secrets` (annotate–kill) | task allowlist (registries read-only; remote; task hosts read-only) — every other host is denied by default; the judge provider hosts are listed under `absent` and asserted absent (T13) | network |
| `config-tamper` (annotate–kill) | protection set: every kill-tier dir/file of the sandbox home as `read_only`, the hook binary and `/etc/claude-code` covered by the baseline, refusal when any of them sits under a `read_write` root | filesystem |
| `tainted-destructive` (hold–deny) | none: taint is not visible to the kernel (recorded in `absent` as `why: "no kernel equivalent"`) | — |
| `default-branch-guard` (hold–deny) | none: the branch is not visible at L7; a blanket `deny_rules` on `git-receive-pack` would block every push | — |
| `off-repo-write`, `opaque-exec` (≤ hold) | not deny-class; the workspace `read_write` limit is the protection fragment anyway | — |

Protection layout (D-107), Claude Code (`home=/home/agent`, `workspace=/sandbox`):

```yaml
version: 1
filesystem_policy:
  include_workdir: false
  read_write: [/sandbox, /home/agent/.claude/projects, /home/agent/.claude/plans, /home/agent/.claude/todos,
               /home/agent/.claude.json, /home/agent/.cache, /home/agent/.npm, /tmp]
  read_only:  [/home/agent/.claude/settings.json, /home/agent/.claude/settings.local.json, /home/agent/.claude/hooks,
               /home/agent/.claude/plugins, /home/agent/.claude/skills, /home/agent/.claude/agents, /home/agent/.claude/CLAUDE.md,
               /usr, /lib, /etc, /proc, /dev/urandom, /var/log, /usr/local/libexec/jev-cops]   # baseline repeated so `policy set` never drops it
landlock: { compatibility: hard_requirement }
process:  { run_as_user: "1000", run_as_group: "1000" }
network_policies:
  jev_cops_judge: { endpoints: [{ host: host.openshell.internal, port: 17681, protocol: rest, enforcement: enforce,
                    rules: [ {allow: {method: POST, path: /v1/judge}}, {allow: {method: POST, path: /v1/observe}},
                             {allow: {method: POST, path: /v1/session}}, {allow: {method: POST, path: /v1/resolve}},
                             {allow: {method: GET, path: /v1/explain/*}}, {allow: {method: GET, path: /v1/budget/*}} ] }],
                    binaries: [{ path: /usr/local/libexec/jev-cops/cops-hook }] }
  jev_cops_task_registries: { endpoints: [{ host: registry.npmjs.org, port: 443, protocol: rest, enforcement: enforce,
                              access: read-only, allow_encoded_slash: true }], binaries: [{ path: /usr/local/bin/claude }] }
  jev_cops_task_remote:     { endpoints: [{ host: github.com, port: 443, protocol: rest, enforcement: enforce, access: read-write }],
                              binaries: [{ path: /usr/local/bin/claude }] }
```

Why this shape: `~/.claude/` itself is neither writable nor whole-listed, so `settings.json`,
`hooks/`, `plugins/` are inaccessible-or-read-only while the model's own data dirs stay
writable; `~/.claude.json` must be writable (trust flags, onboarding, user-scope MCP servers)
and stays in `config-tamper`'s kill tier — the one config file the kernel cannot protect
(printed gap). The hook registration lives in `/etc/claude-code/managed-settings.d/
50-jev-cops.json` written at image build (`cops install claude-code --managed`), so a
`.claude/settings.json` inside the writable repo or a relocated `CLAUDE_CONFIG_DIR` cannot
remove it ("Only `disableAllHooks` set at the managed settings level can disable managed hooks",
docs/adapters.md row 16). Pi: `~/.pi/agent/extensions` and `~/.pi/agent/settings.json`
`read_only`, `~/.pi/agent/sessions` `read_write`, the judge rule lists the node interpreter's
real path (`readlink -f`, docs: "list real paths rather than symlinks"), `jev-cops.ts` is
loaded with `pi -e` from a read-only path. The provider profile (model endpoint) is attached at
creation and contributes `_provider_*` rules the compiler never emits or removes.

Session-start application (D-109): the baseline (registries from the host copy of the repo's
lockfiles, the git remote host, the judge route, the protection set) is compiled by `cops
openshell create --repo <dir> --harness claude-code --name <sb> --from <image>` and passed as
`--policy` (filesystem sections are creation-only, §2 row 3). Hosts named in the task text are
known only at the first prompt (T11), so copsd applies `jev_cops_task_hosts` with `openshell
policy update <sb> --rule-name jev_cops_task_hosts --binary <agent> --add-endpoint
<host>:443:read-only:rest:enforce --wait --timeout 20` when `/v1/session prompt` pins the task,
before answering the hook, then confirms `policy list` shows the revision `Loaded`. Re-applies
are idempotent (same rule name; `--add-endpoint` "Add or merge an endpoint").

Wrapper: `OpenShellCli` runs `[openshell] binary` (absolute; found on PATH at boot and
recorded, like git in D-067) with `OPENSHELL_WORKSPACE` from config, a scrubbed environment,
`--output json` where the command has it, and a 20 s deadline; exit 1 / 124 from `--wait` are
`rejected` / `timeout`. `--dry-run` (D-108): compile, then `policy get <sb> --base --output
json`, diff, print, exit 0 (no change) or 3 (changes); without a reachable gateway the diff is
against the golden. `cops openshell apply --sandbox <sb>` runs the updates in order and stops
at the first failure.

Daemon wiring (`packages/daemon/src/openshell.ts`, D-104/D-105): `[openshell]` table —
`sandbox` (name), `binary`, `listen` (a second loopback bind for the judge route; the
`Surface` type gains `sandbox`, same routes as `agent`), `harness`, `home`, `workspace`,
`hook_binary`, `agent_binaries`, `interpreter`, `jit_ttl_ms` (1 800 000), `jit_max_live` (8),
`stop_on_kill` (true). Requests on the `sandbox` listener belong to sandboxed sessions: the
daemon sets `derived.sandbox = { kind: "openshell", name }` (the adapter's `env.sandbox` is
informational; the environment feature reads the derived value). `[daemon] home` is the
sandbox HOME for such a copsd (D-003 expansion). One sandbox per copsd in M2.

## 5. JIT grants with TTL (spec step 3)

Trigger and scope (D-110): a hold resolved with allow whose event is `net` with a host, when
`host:port` is not allowed by the effective policy (`policy get --full`, cached 10 s and
refreshed after every apply). The grant is one new rule: `openshell policy update <sb>
--rule-name jev_cops_jit_<n> --binary <each agent binary> --add-endpoint
<host>:<port>:read-write:rest:enforce --wait --timeout 20` (`<host>:<port>::tcp` when the
event's port is not 80/443 or the scheme is not http(s)). A fresh rule per grant avoids the
"complete `--binary` list must match the rule" constraint of L7 appends and keeps revocation to
`--remove-rule jev_cops_jit_<n> --wait`. TTL: `min(now + jit_ttl_ms, session cap)` with the
default 30 min; revoked by a timer, by `/v1/session end` of the root, by session GC, and by a
boot reconcile that removes every `jev_cops_jit_*` rule the store does not know or has expired
(the gateway may have kept them across a copsd crash). Stored in SQLite `jit_grants` (rule,
root session, host, port, event id, by, granted_at, expires_at, revoked_at, revoke_error);
audited as `precedent` lines `jit-grant` / `jit-revoke` / `jit-revoke-failed`. At most
`jit_max_live` live grants per root (a farming cap, T7): past it the precedent is still recorded
and the grant refused with an `anomaly` line.

Who can grant (D-111). Without OpenShell nothing changes from M1: Pi's `/v1/resolve` with the
hold token grants the precedent (D-059), and no JIT applies (no sandbox). Under OpenShell:

- Pi: the extension's confirm still works, but a resolve arriving on the `sandbox` listener
  **allows the one call only** — no precedent, no JIT. Reason: §2 row 9; every tool Pi spawns
  inherits node's network identity, so an agent's `curl` can post its own `/v1/judge`, receive
  that hold's token and resolve it (the self-minted hold of STATUS "Next"). Removing the prize
  (precedent, grant) from in-sandbox resolves closes the farm; the budget surcharge (D-023) still
  charges each hold.
- Claude Code: no resolve path (D-079). The human grants on the host: `cops grant <event-id>
  [--ttl 30m] [--by name]` (admin socket, `POST /v1/grant`) records the precedent with the
  daemon-proposed scope (D-051) **and** applies the JIT grant; the ask text (D-096 summary) adds
  "Network access to <host> needs a grant: run `cops grant <event-id>` before accepting." A
  tool run without the grant is denied by the kernel (`policy_denied`), which the post event
  shows; nothing leaks.
- Precedents (D-051) are unchanged in scope and TTL; a JIT grant never widens a precedent and
  is never promoted; hold tokens (D-059) are unchanged: the sandbox-listener resolve still needs
  the token to allow the call (an unauthenticated resolve stays 403 + anomaly).
- Filesystem: no grant (startup-only, §2 row 3). Documented in the ask text and the gap list.

T7 todo rows: "OpenShell JIT grants from a resolved hold are time-boxed" → deterministic
(fake `openshell`: grant argv, expiry revoke, session-end revoke, cap); "an agent that posts its
own judge request gets that hold's token and can resolve it" → deterministic: on the sandbox
listener the resolve answers `{ ok: true, precedent: null, once: true }`, no precedent row, no
`policy update` argv recorded; and on Claude Code the judge rule's `binaries` is the hook only
(a compiled-fragment assertion).

## 6. Audit off-box and chain verification (T12, owner decisions D-115–D-117)

Forwarder (D-115). `packages/daemon/src/audit-forward/`:

```ts
interface AuditForwarder {
  open(): Promise<void>;                 // connects; never throws into the caller of append()
  send(line: AuditLine): void;           // enqueues; disk cursor `~/.jev-cops/forward.cursor` = last seq handed to the transport
  status(): { kind: string; connected: boolean; lastSentSeq: number; queued: number; lastError: string | null };
  close(): Promise<void>;                // flush with a 2 s budget
}
// [audit.forward] kind = "file" | "syslog"; syslog: target = "host:port", tls = { ca, cert?, key?, server_name? },
//   facility = "local0", app_name = "copsd", enterprise_number = 32473 (the RFC 5424 example PEN until the team registers one),
//   max_message_bytes = 1048576, required = false, max_lag_lines = 10000
```

Each audit line is one RFC 5424 message, octet-counted per RFC 5425 §4.3.1 (`MSG-LEN SP
SYSLOG-MSG`), over `tls.connect` with the server certificate verified against `[audit.forward]
tls.ca` (client certificate optional): `<PRI>1 <at as RFC 3339> <hostname> copsd <pid> <kind>
[jevcops@<PEN> seq="…" prev="…" hash="…" kind="…" event_id="…" session_id="…"] <canonical JSON line>`.
Severity: `notice` for every kind, `warning` for `anomaly`. Lines above `max_message_bytes`
are split into parts (`part="i/n"` in the SD element; the verifier reassembles; foreign
receivers see parts). Continuity across forwarding: `seq`/`prev`/`hash` travel in the SD
element, so a receiver-side verifier rebuilds the chain without parsing MSG; reconnects resend
from the cursor (duplicates carry the same seq+hash and are dropped by the verifier). Forwarding
never blocks judging: on a dead receiver the queue grows on disk (the local file is the queue;
the cursor marks progress) and `/v1/health` reports the lag; `required = true` makes
`/v1/judge` answer 503 once the lag passes `max_lag_lines` (fail closed by opt-in). The `file`
forwarder keeps today's behaviour behind the same interface.

Signed checkpoints (D-116). A new audit kind `checkpoint` (chained like every line) is appended
every `[audit] checkpoint_every` lines (100) and at every root `session end`, at boot (over
the tail found on open), at shutdown and at key rotation:

```json
{ "kind": "checkpoint", "seq": 301, "prev": "…", "hash": "…", "at": …,
  "payload": { "alg": "ed25519", "key_id": "3f9a…", "head_seq": 300, "head_hash": "…", "since_seq": 201,
               "reason": "interval" | "session-end" | "boot" | "shutdown" | "rotation",
               "sig": "<base64url Ed25519 over `jev-cops.audit.checkpoint/1\n<key_id>\n<head_seq>\n<head_hash>`>",
               "next_key_id": "…", "next_public_key": "<SPKI PEM>" } }   // rotation only
```

Keys: `cops keygen [--rotate] [--dir ~/.jev-cops/keys]` writes `audit-ed25519.key` (PKCS #8
PEM, 0600, dir 0700) and `~/.config/jev-cops/audit-ed25519.pub` (SPKI PEM, printed with
`key_id` = first 16 hex of SHA-256 of the raw public key). Both directories are already in
`protectedPaths`; the key file joins `privatePaths` (D-098) — and under OpenShell the sandbox
has no path to the host's `~/.jev-cops` at all. Rotation appends a `checkpoint` with
`reason: rotation` signed by the old key and carrying the new public key, then continues with
the new key; a verifier trusts the root public key it was given and follows rotations in-chain.
copsd boots without a key with a loud warning ("audit checkpoints unsigned: run `cops keygen`");
`[audit] require_signing = true` makes that fatal. Why this closes L6: without the private key
nobody can produce a checkpoint, so a full recompute fails at the first checkpoint after the
rewrite point, and a tail truncation is bounded to the lines after the last checkpoint locally
(< `checkpoint_every`, or none after a session end) and to zero against the off-box copy.

Verification (D-117). `cops audit verify <local.jsonl> --pubkey <pub> [--remote <copy>]
[--json]` needs no daemon: chain (as today), every checkpoint's signature against the key in
force at that seq, `signed_through` and `unsigned_tail`; with `--remote` (our JSONL, or a file
of raw RFC 5424 frames as a receiver wrote them, reassembled) both chains verify and must agree
line by line up to the shorter length; remote longer than local **past a signed checkpoint** =
"local tail truncated after seq N" (fail); local longer = "forwarding lag N" (warn). `cops
doctor` runs the same with `[audit] public_key` (or `--audit-pubkey`) and reads `/v1/health`
`audit.forward` for the live lag; it fails when signing is required and no key exists, warns
on lag > 0 for more than 60 s, and prints the receiver's last-seen seq when the team's copy is
given.

T12 rows: deterministic — an in-test TLS syslog receiver (`tls.createServer`, self-signed CA)
asserts framing, SD fields, chunking, resume after a dropped connection, dedup; checkpoint
signing and `cops audit verify` on: an intact log, a tail truncated after a checkpoint with a
longer remote copy (fail), a full recompute (signature fails), a forged checkpoint with another
key (fails), a rotation followed by the new key (passes); `cops doctor` exit 1 on each failure.
Gated — the same against an `rsyslog` container (`imtcp` + TLS) started by the live script.

## 7. Closing the M0/M1 OpenShell-dependent gaps

| Gap | Under OpenShell | Residual |
|---|---|---|
| Self-minted holds / agent's tools on the socket (T7 todo, STATUS "Next") | Claude Code: `jev_cops_judge` lists only `cops-hook` (hash-pinned), rules limited to six paths; a tool's `curl` has no route (§2 row 9). Pi: not separable by binary; in-sandbox resolves allow once only (D-111). Both: the admin socket is a host Unix socket with no route at all. | The agent can exec `cops-hook` itself with a crafted payload: `config-tamper` holds a tool call whose argv names `cops-hook`/`cops hook`/`cops grant` (D-114); an opaque exec hides it (`opaque-exec` annotates/holds). What it gains: a view of its own fake event, budget burn; never a precedent or grant. Printed. |
| Agent-readable private records (D-098) | Closed: `~/.jev-cops` (audit, store, keys, hook log) is on the host; the sandbox has no path or mount to it. | The Claude Code transcript under the sandbox `~/.claude/projects` keeps the ask text (reason, command, summary; no score, D-096). Printed. |
| SIGKILL/SIGUSR1 of the hook (PLAN-M1 §5 row 2, L3) | Not closed: the hook is the agent's own child inside the sandbox, same UID; OpenShell's process controls do not separate them (`PROC:` OCSF events only observe). | Printed as before; the kill latch and `config-tamper` (`pkill cops-hook` held) stay the guards. |
| `pkill copsd` by pid (D-100 gap) | Closed: copsd is outside the sandbox (no PID visibility, no signal route, no socket); only the L7-restricted judge route exists. | Without OpenShell unchanged. |
| Confused-deputy git read (D-069) | Closed by construction: the daemon opens no sandbox path; `env.git` (and `remote_host`, `lockfiles`, optional additive fields of `env.git`) come from the hook running the same hardened runner inside the sandbox (`derived.git.by: "hook"`, D-113). | Without OpenShell unchanged (LOW). |
| Config dirs relocated by env (`CLAUDE_CONFIG_DIR`, `PI_CODING_AGENT_DIR`, `XDG_CONFIG_HOME`) | Claude Code: the hook is managed under `/etc` (baseline read-only), which a relocated config dir does not move; the relocated dir is still writable, so a nested `claude` started with it is held at spawn (D-072 + the env-prefix rule of D-114). Pi: `-e` from a read-only path; a relocated `PI_CODING_AGENT_DIR` is held at spawn the same way. | A nested harness that gets past the hold runs unjudged on the same network rules (its model endpoint is a provider rule for the same binary). Printed. |
| T1 kernel write failure | Closed for kill-tier files outside writable trees (§4 layout); `~/.claude.json` and project `.claude/settings.json` stay writable (§2 row 2) and rely on `config-tamper` + ConfigChange + managed hooks. | Printed. |
| T13 judge exfil path | Closed: the provider host is absent from the sandbox policy (asserted; prover boundary), DNS for it fails ("OpenShell answers DNS queries for the hosts in your rules"), copsd calls it from the host. | — |
| `kill` cannot end the process (PLAN-M1 §5 row 13) | Closed: `openshell sandbox stop` after the latch (D-112). | Without OpenShell unchanged. |
| Hook killed/not started in 30 s (CLAUDE_CODE_GAPS row 2) | Not closed (same UID). | Printed. |

## 8. Fail-closed analysis (M2)

| # | Path | Closed by | Residual |
|---|---|---|---|
| 1 | No `[openshell]` table (laptops, CI): `sandbox.kind: none` | Everything as M1; copsd boot line, `cops install`, `cops doctor` print "Without OpenShell, every deny is best-effort" (spec §Without OpenShell); doctor group `openshell`: `warn` "not configured". | — |
| 2 | `[openshell]` set but `openshell` missing, gateway unreachable, sandbox absent or not `Ready` at boot | copsd refuses to boot with the reason (the operator asked for a sandbox it cannot manage); doctor `fail`. | — |
| 3 | Apply fails at first prompt (`--wait` exit 1/124, gateway down, global policy active) | The session is flagged `sandbox_policy: failed`; every `net`-kind event of it is at least `hold` (deny headless) until a later apply succeeds; `anomaly` line; doctor warns "global policy active: jev-cops cannot apply". The kernel default-denies the hosts jev-cops could not allow anyway (availability, not safety). | — |
| 4 | Filesystem fragments cannot be applied after start | Creation-only by `cops openshell create --policy`; a running sandbox whose base policy lacks the protection set is reported by doctor (`policy get --base` vs compiled) as `fail`: recreate. | An operator who created the sandbox without `cops openshell create`. Printed. |
| 5 | JIT apply fails | Precedent recorded, grant refused, `anomaly`; the tool's network call is kernel-denied and visible in the post event. | — |
| 6 | JIT revoke fails (gateway down at expiry) | Retry with backoff; `jit-revoke-failed` line; doctor warns "grants past expiry: N"; boot reconcile. | A grant outlives its TTL while the gateway is down. Printed. |
| 7 | Bad YAML would black out the sandbox (`fail_closed` validation) | Local schema mirror + prover before any gateway write; the fake `openshell` rejects the documented invalid shapes in tests. | Docs drift in the schema: doctor prints the verified OpenShell version (0.1.2) and warns on drift like Claude Code's. |
| 8 | Landlock cannot apply the protection set | `landlock.compatibility: hard_requirement`: the sandbox does not start (§2 row 16). | — |
| 9 | Advisor auto-approval widens egress | `cops openshell create` sets manual/off; doctor `fail` when auto is on (D-119). | An operator turning it on later between doctor runs. |
| 10 | The judge route is not applied → hook cannot reach copsd | The hook fails closed (T2/D-085); `cops openshell create` runs the offline canary through `openshell sandbox exec -- cops-hook …` before handing over the sandbox. | — |
| 11 | Docker Desktop without host networking / with ECI | OpenShell's own fail-closed: the supervisor never connects, the sandbox stays `Provisioning`, nothing runs; doctor prints the prerequisite. | — |
| 12 | Forwarder down | Judging continues (observe class); lag in `/v1/health`, doctor warns; `required = true` opts into 503 past `max_lag_lines`. | Tail exposure bounded by the last checkpoint (§6). |
| 13 | Signing key missing | Loud boot warning, doctor warn; `require_signing = true` → boot refused. | — |
| 14 | A `policy set` by someone else drops our rules | Doctor compares `policy get --base` with the compiled policy every run (`fail` on a missing `jev_cops_judge` or protection path); copsd re-applies network rules at the next prompt. | Filesystem changes need a recreate (row 4). |

## 9. Test list

Runner `bun test`; sibling `*.test.ts` per module; goldens under `packages/openshell/fixtures/`;
the fake `openshell` in `packages/openshell/testing/`; nothing below needs Docker or a gateway
except the last block.

**step 0** — loader skips `_lib/` and `_x.ts`; `bun run gate` unchanged (133 cases, 266 runs);
`policies.test.ts` file filter ignores `_lib`; `cops test policies` output unchanged.

**compiler unit** — `policyFragmentsFor` per starter policy (table §4) · task allowlist:
lockfiles → registries, `git@github.com:o/r` → tcp/22 `tls: skip`, `https://…` → 443
read-write, task URLs and bare hosts → read-only, file names excluded (reuses core
`taskAllowlist`) · judge route: only the six paths, only the hook/interpreter binary · JIT
rule naming and tcp/rest choice · refusals: protected dir under `read_write`, path with `..`,
> 256 paths, `read_write: ["/"]` · `absent` lists the judge provider hosts (jev, openrouter,
vercel-ai base URLs from `@jev-cops/judge`) and every provider host · emit determinism (same
input → same bytes; key order) · diff: added/removed/changed rules and paths.

**compiler fixtures (golden YAML)** — claude-code × pi × {no lockfiles, npm+pypi lockfiles} ×
{https remote, ssh remote, no remote} × {task with hosts, task without}; each golden also passes
the schema mirror, and `openshell-prover check <golden> --boundary boundary/no-judge-hosts.yaml`
and `--boundary boundary/config-read-only.yaml` when `openshell-prover` is on PATH (else the
test prints "prover not installed: boundary check skipped" and passes; CI caches the v0.1.2
prover archive so the check runs there).

**wrapper + fake** — argv byte-exact for `policy update` (task hosts, JIT grant/revoke),
`policy get --base --output json` parsing, `policy list` Loaded detection, exit 1/124 mapping,
deadline kill, scrubbed env, `sandbox create` flags (`--policy`, `--no-auto-providers`,
`--approval-mode manual`, `--env`), `settings set` pairs, `sandbox stop`.

**daemon** — sandbox listener surface and `derived.sandbox` · first prompt triggers one apply
with the task hosts; second prompt none · apply failure → net events held, allow after a later
success · global policy → held · kill → latch then `sandbox stop` argv · JIT: grant on
`cops grant`, none on a sandbox-listener resolve (`once: true`, no precedent row), TTL timer
revoke, session-end revoke, GC revoke, cap at `jit_max_live`, boot reconcile removes unknown
`jev_cops_jit_*` · `/v1/health` reports sandbox, revision, grants, forwarder.

**audit** — syslog framing (RFC 5425 octet count), SD element fields, severity, chunking at
`max_message_bytes`, TLS verification against the test CA (a wrong CA refuses), reconnect and
resume from the cursor, dedup on the verifier · checkpoints every N lines, at session end,
boot, shutdown, rotation · `cops keygen` files and modes, `--rotate` chain · `cops audit
verify`: the six cases of §6 · doctor: key missing (warn / fail with `require_signing`), lag,
truncation against `--remote`.

**adapters** — hook `--url http://host.openshell.internal:<port>` client (same deadlines and
fail-closed matrix as the socket client), sandbox detection (informational) · Pi
`INSTALLED_URL` · hook-side git derivation returns the same fields as the daemon's probe on
the fixture repos; the daemon marks `derived.git.by: "hook"` and does not probe.

**config-tamper (D-114)** — `cops-hook …`, `cops hook`, `cops grant`, `cops keygen`, `cops
openshell apply` from a tool call → hold; `CLAUDE_CONFIG_DIR=/x claude`, `PI_CODING_AGENT_DIR=/x
pi` → `harness-config` verb → hold; fixtures added to `config-tamper.fixtures.json`.

**doctor** — group `openshell`: binary/version (0.1.2 verified; warn on drift), gateway
reachable, sandbox phase `Ready`, base policy contains the compiled protection set and judge
route (`fail` otherwise), latest revision `Loaded`, advisor settings, grants past expiry,
forwarder lag, signing key and public key; every new gap line printed; `--json` unchanged shape.

**tamper (deterministic, CI)** — T1: compiled protection set covers every kill-tier path of
`config-tamper`'s trees for the sandbox home, none under `read_write`, prover boundary passes ·
T4: the fragment for a `permissions.allow`-bypassed `curl https://exfil.example` has no rule for
that host and the judge rule excludes `curl` · T7: the two rows of §5 · T12: the six cases ·
T13: no judge provider host in any golden, `jev_cops_judge` binaries = hook only, paths = the
six; `absent` names the provider hosts. Each `test.todo` body is replaced, never deleted
(CONTRIBUTING); the live halves are `test.skipIf(!LIVE)` named `OpenShell live: …` (D-120).

**live (never in CI, `scripts/openshell-live.sh`, D-118)** — requires `JEV_COPS_OPENSHELL_LIVE=1`,
`openshell` on PATH with a local gateway (`openshell status`), Docker Desktop host networking
on (the §1 probe re-run first), a throwaway `HOME`, `judge = off`, a fake Anthropic Messages
API and a fake "judge provider" HTTP server on the host (never real credentials). Steps: build
`linux/arm64` binaries; `docker build docker/claude-code.Dockerfile` (ubuntu 24.04, `claude`,
`cops-hook` at `/usr/local/libexec/jev-cops/`, managed install, `/etc/openshell/policy.yaml`
from the compiler); `cops openshell create`; assert: `Write ~/.claude/settings.json` inside the
sandbox → `EACCES` and the hook's kill; `curl https://<judge-provider host>` → DNS failure /
`policy_denied` with the OCSF `DENIED` line, while copsd's call from the host succeeds (T13);
a `curl` to a non-allowlisted host → `403 policy_denied` (T4); `cops grant` → the host answers
within the TTL, denied again after `--remove-rule` (T7); `kill` → sandbox `Stopped` (D-112);
rsyslog receiver gets every line, `cops audit verify --remote` passes, then fails on a local
truncation (T12). Then the same image family for Pi (`pi -e /opt/jev-cops/jev-cops.ts`).
Output → `docs/captures/openshell-m2.md`.

## 10. Owner decisions and proposed DECISIONS rows

No open question remains for the owner: the audit destination answer (syslog over TCP+TLS,
Ed25519 signed checkpoints, key outside the sandbox, public key with the team, verification by
doctor and the team) is recorded as D-115–D-117 below. What the plan needed from it and now
has: the transport (RFC 5424 message layout, RFC 5425 framing, TLS trust settings, in-test
receiver), the key custody model (`cops keygen`, rotation in-chain, `require_signing`), and the
doctor's local-vs-off-box check (`--remote`). If the team later wants S3 or a SIEM API, it is a
third `AuditForwarder` with the same line format.

Proposed rows (safer option chosen; numbered from D-103 in landing order):

- **D-103** Loader skips `_`-prefixed files and never recurses; shared policy helpers live in
  `policies/_lib/`; `config-tamper` splits into `_lib/config-trees.ts`, `_lib/judge-guard.ts`
  and the policy file, behaviour byte-identical on the fixture gate. SDK-level path-tier
  helpers are deferred until a second policy needs them (YAGNI; the SDK is a published API).
- **D-104** A session is sandboxed when its requests arrive on the `[openshell] listen`
  loopback listener (surface `sandbox`), never because the adapter says so; the daemon sets
  `derived.sandbox = { kind: "openshell", name }` and the environment feature reads it. One
  sandbox per copsd (`[openshell] sandbox`); `[daemon] home` is the sandbox HOME.
- **D-105** No Unix socket is mounted into a sandbox (the docs discourage bind mounts and
  require admission off). The hook and the Pi extension reach copsd at
  `http://host.openshell.internal:<port>` through the supervisor under `jev_cops_judge`:
  `protocol: rest`, `enforcement: enforce`, allow rules exactly `POST /v1/judge|observe|
  session|resolve`, `GET /v1/explain/*|/v1/budget/*`, `binaries` = the hook binary (Claude
  Code) or the node interpreter (Pi). The admin socket stays a host Unix socket. The listener
  is loopback-only like `[daemon] http` (D-048).
- **D-106** OpenShell is allow-only, so the compiler's deny fragments are omissions and L7
  `deny_rules`: `exfil-after-secrets` → the task allowlist (registries read-only with
  `allow_encoded_slash`, git remote read-write https or tcp/22 `tls: skip`, task hosts
  read-only) with the judge provider hosts asserted absent; `config-tamper` → the protection
  set; `tainted-destructive` and `default-branch-guard` → none (recorded in `absent`). The
  compiler refuses a policy where a protected path sits under a `read_write` root (Landlock
  grants, never revokes) and emits `landlock.compatibility: hard_requirement`.
- **D-107** Sandbox layout: HOME outside the workspace; harness config files and dirs
  `read_only` (Claude Code `settings*.json`, `hooks/`, `plugins/`, `skills/`, `agents/`,
  `CLAUDE.md`; Pi `agent/extensions`, `agent/settings.json`); writable exceptions listed
  explicitly (`~/.claude/projects|plans|todos`, `~/.claude.json`, caches, Pi sessions); the
  Claude Code hook installed **managed** in the image under `/etc/claude-code/
  managed-settings.d/` (read-only baseline); `~/.claude.json` and a project's `.claude/
  settings.json` remain kernel-writable and stay `config-tamper` kill-tier (printed gap).
- **D-108** `--dry-run` is jev-cops's (OpenShell's `policy set` has none): compile locally,
  diff against `policy get --base --output json` when a gateway answers, else against the
  golden; exit 3 on changes; no gateway write. CI runs it on fixtures.
- **D-109** Baseline fragments (protection, judge route, registries, remote) are applied at
  creation by `cops openshell create --policy`; task-text hosts at the first prompt through
  `policy update … --wait --timeout 20` then `policy list` Loaded; an apply failure or an
  active global policy flags the session and holds every `net` event (deny headless) until a
  later apply succeeds.
- **D-110** JIT grants are network-only (filesystem rules are startup-only): one
  `jev_cops_jit_<n>` rule per grant (rest read-write, or tcp), TTL `min(30 min, session end)`,
  revoked by timer, root session end, GC and boot reconcile, at most 8 live per root; recorded
  as `precedent` lines; a failed apply refuses the grant with an anomaly.
- **D-111** Under OpenShell a resolve on the sandbox listener allows the one call and grants
  neither precedent nor JIT (Pi's tools share node's network identity; self-minted holds);
  `cops grant <event-id>` on the admin socket (`POST /v1/grant`) records the precedent with
  the daemon-proposed scope and applies the JIT grant, for Claude Code and Pi alike. Without
  OpenShell M1 behaviour (D-059, D-079) is unchanged.
- **D-112** A `kill` in a sandboxed session also runs `openshell sandbox stop <name>` after
  the latch (spec verdict table); a failed stop is audited and the latch still holds.
- **D-113** Under OpenShell the hook derives `env.git` inside the sandbox with the same
  hardened runner and sends it (plus additive optional `env.git.remote_host` and
  `env.git.lockfiles`); the daemon records `derived.git.by: "hook"` and opens no sandbox
  path, which closes D-069 for sandboxed sessions.
- **D-114** `config-tamper@3`: an agent-run `cops-hook`, `cops hook`, `cops grant`, `cops
  keygen` or `cops openshell` → hold; `CLAUDE_CONFIG_DIR`, `PI_CODING_AGENT_DIR` or
  `XDG_CONFIG_HOME` set on a harness CLI command adds the `harness-config` verb (hold).
- **D-115** (owner) Pluggable `AuditForwarder`; `file` and `syslog` (RFC 5424 over TCP+TLS,
  RFC 5425 octet-counting framing, server certificate verified against a configured CA, one
  message per line with `seq`/`prev`/`hash` in the SD element, chunking above 1 MiB, disk
  cursor and resume, dedup by seq+hash); forwarding never blocks judging unless
  `[audit.forward] required = true`.
- **D-116** (owner) Ed25519-signed `checkpoint` lines every `checkpoint_every` (100) lines
  and at root session end, boot, shutdown and rotation, signing `head_seq|head_hash|key_id`
  under a domain string; private key `~/.jev-cops/keys/audit-ed25519.key` (0600, private and
  protected; no sandbox path to it), public key `~/.config/jev-cops/audit-ed25519.pub`
  handed to the team; `cops keygen [--rotate]`, rotation announced in-chain signed by the
  old key; copsd warns without a key, `[audit] require_signing = true` refuses to boot.
- **D-117** (owner) `cops audit verify <local> --pubkey <pub> [--remote <copy>]` and `cops
  doctor` verify chain, every checkpoint signature and local-vs-remote agreement: a remote
  longer than local past a signed checkpoint is a local truncation (fail); local longer is
  forwarding lag (warn); `/v1/health` exposes the forwarder's lag.
- **D-118** Live OpenShell verification is a separately gated step (`scripts/openshell-live.sh`,
  `JEV_COPS_OPENSHELL_LIVE=1`, `openshell` on PATH, Docker Desktop host networking on,
  throwaway HOME, fake provider APIs, no real credentials), never part of `bun test` or CI;
  CI validates emitted YAML with the schema mirror and, with the cached v0.1.2 prover,
  `openshell-prover check`; results go to `docs/captures/openshell-m2.md`.
- **D-119** `cops openshell create` sets `agent_policy_proposals_enabled=false` and
  `proposal_approval_mode=manual` on the sandbox; `cops doctor` fails when automatic approval
  is on for the judged sandbox (an agent-proposed public host would bypass the judge).
- **D-120** Every OpenShell-dependent tamper row has a deterministic CI part (compiled
  fragment or fake `openshell`) and a live part gated by `skipIf`; a `test.todo` is replaced
  the moment its deterministic part exists, never deleted.

## 11. Lead amendments (2026-09-30)

1. **Decision numbering.** The owner's answers were recorded first as **D-103** (syslog behind a
   pluggable forwarder) and **D-104** (Ed25519-signed checkpoints, public key with the cyber
   team). The proposals in §10 are recorded from **D-105** on, in the order they land; §6's
   D-115–D-117 are the implementation detail of D-103/D-104.
2. **Execution order.** Step 0 first (the compiler's protection fragment reuses the tier
   trees it extracts into `policies/_lib/`); step 5 (audit) in parallel from the start; steps
   1–2 after step 0; then 3–4; session boundary; then 6–9.
3. **Live verification (step 9)** needs Docker Desktop host networking enabled (measured off
   on 2026-09-30) and Enhanced Container Isolation off — an owner action, asked when step 9
   starts.
