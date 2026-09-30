# Setup plan — one-command install, `cops setup`, pluggable security scanners

Owner request (2026-09-30): "the cops setup should be easy and allow to install by choosing the
security scanner we want as option (nvidia skillspector for ex)" and "keep it easy to install ;)",
then "publishable to npm". Neither a setup wizard nor a scanner is in [SPEC.md](./SPEC.md); this
track is a spec extension recorded like D-004 (S-1 below). Source of truth otherwise: the spec,
[DECISIONS.md](./DECISIONS.md) (D-044 keys from env only, D-047 observe by default, D-048 config
precedence, D-053 compiled binaries, D-073 config-tamper tiers, D-082/D-098 protected and private
paths, D-089–D-092 install/doctor, D-096 score-free confirm prompts, D-103/D-104 audit forwarder and
signing) and [PLAN-M2.md](./PLAN-M2.md) §3 (this track runs beside M2 steps 1–5; file ownership in §3).

Distribution shape (owner update, being built by another agent): an unscoped npm meta package
`jev-cops` (free on npm) depending on `@jev-cops/cli`, `@jev-cops/daemon`,
`@jev-cops/adapter-claude-code`, `@jev-cops/adapter-pi` and a new `@jev-cops/policies` (the starter
set, the daemon's default policies dir when the user has none), exposing the `cops`, `copsd` and
`cops-hook` bins. Runtime stays Bun (D-007). This plan builds the setup path on top of it and does
not touch the package files.

Docs re-read on 2026-09-30 (ground rule: docs win over memory). Sources are quoted in §2; fetched
copies under `/private/tmp/claude-501/…/scratchpad/{skillspector,scanners,xc}/`.

## 1. Definition of done and gate

> A new user goes from nothing to a working, doctor-verified jev-cops for Claude Code **in one
> command and under two minutes**, choosing SkillSpector as the scanner — `bunx jev-cops setup`
> with Bun installed, or `curl -fsSLO …/install.sh && sh install.sh` without — and an attempt to
> install a skill SkillSpector rates `DO_NOT_INSTALL` is denied with the findings in the audit line,
> a `CAUTION` one is held with the findings in the confirm prompt, in plain language, no score.

| Item | Planned as |
|---|---|
| One-line install, with Bun | `bun add -g jev-cops` (or `npm i -g jev-cops` with `bun` on PATH), then `cops setup`; `bunx jev-cops setup` for a zero-install first run (it installs `jev-cops` globally on a yes, so the service and hooks point at a stable path, §6) |
| One-line install, without Bun | `install.sh` + GitHub Releases: compiled `cops`, `copsd`, `cops-hook` for `darwin-arm64`, `darwin-x64`, `linux-x64`, `linux-arm64` (`bun build --compile --target`, verified §2), SHA-256 sums verified, provenance attestation optional, `~/.local/bin` or `--prefix`, no sudo (§7) |
| `cops setup` | interactive wizard + fully flagged `--yes` form, `--dry-run`, idempotent re-runs, `--uninstall`; never writes without showing the plan and getting a yes; never installs a third-party tool silently (§6) |
| `copsd` as a login service | `cops service install|uninstall|status|start|stop|logs`: launchd user agent on macOS, `systemd --user` unit on Linux, absolute paths only, golden-file tested (§7.3) |
| Pluggable scanners | `@jev-cops/scanner`: `Scanner` interface, `createScanner(config)` factory mirroring `@jev-cops/judge`; adapters `none`, `skillspector`, `command` (a documented JSON contract any tool can print); static mode default (§4) |
| Where scanning hooks into judging | starter policy `skill-install` (range annotate→deny) fed by a daemon-side scan gate with a two-phase design: inline within budget, else hold "scan pending" and a content-hash cache serves the retry (§4.3, §5) |
| For humans | `cops scan <path|url> [--json]`; `cops setup` and `cops doctor` scan the already-installed skills once and report (never block) (§4.4) |
| Release | `.github/workflows/release.yml` on manual dispatch: four targets, sums, attestations, draft release; npm publish job with provenance behind an input flag. Publishing (repo visibility, npm org `@jev-cops`, 2FA, Apple signing) is an owner action; nothing here assumes it ran (§7.1, §12) |

**Gate.** (1) `bun test` green with the tests of §10; `bun run gate` with 7 policies. (2) The
end-to-end setup test: on a throwaway `HOME` with a fake `claude`, a fake `skillspector` and a
fake release server, `cops setup --yes …` then `cops doctor` exit 0, then a `Write` of a
`DO_NOT_INSTALL` fixture skill under `~/.claude/skills/x/SKILL.md` through the installed hook
→ `deny`; a `CAUTION` one → `ask` with the findings; `cops setup --uninstall` leaves only
`~/.jev-cops/audit.jsonl` and the keys. (3) A captured real first run (`docs/captures/setup.md`)
with the real `uv tool install` and the real `skillspector` on a throwaway `HOME`, timed under two
minutes on this Mac (M1: `uv` and Python 3.14 present, `skillspector` absent).

## 2. Research: facts and sources

| # | Topic | Fact (source, quote) | Consequence |
|---|---|---|---|
| 1 | SkillSpector version, license, runtime | `pyproject.toml`: `version = "2.12.0"`, `license = "Apache-2.0"`, `requires-python = ">=3.12,<3.15"`; releases v2.12.0 (2026-09-23) … v2.10.0; GitHub API `pushed_at` 2026-09-30. **Not on PyPI** (`pypi.org/pypi/skillspector/json` → no releases). README: `uv tool install git+https://github.com/NVIDIA/skillspector.git`; "Update later: `uv tool update skillspector`"; Docker: "Build the image … `docker build -t skillspector .`" from the included Dockerfile (`python:3.12-slim-bookworm`), no published image. | Install = git clone + build at install time (needs `uv`, `git`, Python 3.12–3.14; this Mac has Python 3.14.2 and `uv`). The wizard offers exactly the two documented commands and runs one on an explicit yes. |
| 2 | CLI contract | README "Integrating SkillSpector": "Its exit code and JSON output are a stable contract." Exit `0` "risk_score ≤ 50 (recommendation SAFE or CAUTION), and no enabled strict gate fired"; `1` "risk_score > 50, `--fail-on-findings` … or `--fail-on-incomplete`"; `2` "Error (bad input, unreadable source, internal failure)". `--format json` to stdout without `-o`; `risk_assessment.recommendation ∈ SAFE | CAUTION | DO_NOT_INSTALL` "mapped from severity: LOW → SAFE, MEDIUM → CAUTION, HIGH/CRITICAL → DO_NOT_INSTALL"; `issues[].{id, category, severity, confidence, location.{file, start_line}}`; `metadata.{skillspector_version, llm_requested, llm_available, llm_error?}`; "rely on the fields above and treat any additional fields as best-effort". `cli.py` adds `--recursive`, `--transitive`, `--use-shipped-baseline` (off: "a skill author's baseline can suppress findings in your scan"), `--mcp-registry`. | Exit 1 with valid JSON is a **verdict, not an error**; only exit 2, non-JSON or a schema miss is `error`. The adapter reads `recommendation`, never re-derives it from the score. `--use-shipped-baseline` is never passed. |
| 3 | What leaves the machine in static mode | README "Trust model": "**It never executes the scanned skill.**"; "LLM analysis sends analyzer-eligible file contents to the configured provider … (the default)"; "**SC4 sends dependency names to OSV.dev** … runs even with `--no-llm`. It sends dependency coordinates (not file contents), requires no API key, and falls back to a bundled list when OSV.dev is unreachable." `docs/SC4…`: "Timeout: 10 s connect + read". No offline flag exists. | The lead's "nothing leaves the machine" is not exact: **dependency names and versions go to `api.osv.dev` even in static mode**. The wizard says so; `[scanner] network = "osv-only"` is the documented expectation (S-6). An air-gapped host pays a 10 s stall per uncached scan, which forces the two-phase path (row 5). |
| 4 | Defaults are the unsafe way round | `SKILLSPECTOR_PROVIDER` "Defaults to `nv_build`"; LLM analysis is the default unless `--no-llm`. MCP tool `scan_skill(target, use_llm=true, …)`; "The stdio transport … the initialize hang reported in issue #199 still applies". Docs page says "68 vulnerability patterns", README "71". | The daemon always passes `--no-llm` unless `mode = "llm"` is set explicitly. The MCP mode is not used: default `use_llm=true`, a known hang, no exit codes, and the CLI is the documented stable contract. |
| 5 | Scan duration and bounds | `docs/ANALYSIS_RESOURCE_BOUNDS.md`: "End-to-end workflow time 600 seconds"; "Static-analysis time 300 seconds … one artifact"; `SKILLSPECTOR_MAX_WORKFLOW_SECONDS` overrides the workflow ceiling; per-file analysis cap `MAX_FILE_BYTES` 1 MB; ingest caps 100 MiB / 10 000 zip members. Python start-up plus YARA load is seconds, plus OSV (row 3). | A scan cannot be promised inside copsd's 12 s judge deadline (D-049). Design: inline first look bounded by `[scanner] inline_ms` (6 000), otherwise `hold` "scan pending" while the scan completes in the background (bounded by `deadline_ms`, 60 000, passed as `SKILLSPECTOR_MAX_WORKFLOW_SECONDS`), result cached by content hash for the retry (§4.3). |
| 6 | Snyk Agent Scan (ex Invariant `mcp-scan`) | PyPI `snyk-agent-scan` 0.6.8 (`>=3.10`), Apache-2.0; `invariantlabs-ai/mcp-scan` redirects to `snyk/agent-scan`. README: "CLI output is experimental and subject to change … We do not recommend building production workflows that depend on specific CLI output fields"; `--json` "schema depends on the command and CLI version"; pipeline "discover → inspect → redact → analyze → optional upload", `--analysis-url` "Analysis API endpoint"; "Scanning MCP configurations can execute commands"; scans a single `SKILL.md` or `~/.claude/skills`. | Plugs in through the `command` adapter with a 30-line wrapper in `docs/scanners/snyk-agent-scan.md`; the wizard labels it "analysis is remote (content leaves the machine)". Never a built-in adapter while its output is declared unstable. |
| 7 | Cisco AI Defense Skill Scanner | PyPI `cisco-ai-skill-scanner` 2.1.0 (`>=3.11,<3.15`), README badge Apache-2.0 (GitHub API `NOASSERTION`: check the LICENSE file before recommending). `skill-scanner scan <dir> --format json|sarif|… [--fail-on-severity high]`; core analyzers local ("static + bytecode + pipeline + correlation"), `--use-behavioral` local, `--use-llm`/`--use-aidefense`/`--use-virustotal` optional cloud. Exit 1 on findings at or above the level. | Second `command`-adapter example (`docs/scanners/cisco-skill-scanner.md`). Cisco `mcp-scanner` starts MCP servers to inspect them: not a static gate, out of scope. |
| 8 | Bun cross-compilation (verified here) | Docs (bun.com/docs/bundler/executables): targets `bun-linux-x64`, `bun-linux-arm64`, `bun-linux-x64-musl`, `bun-linux-arm64-musl`, `bun-windows-x64`, `bun-windows-arm64`, `bun-darwin-x64`, `bun-darwin-arm64`; embedded files via `with { type: "file" }` under `/$bunfs/` (what `parser.ts` uses for both WASM files). Measured with Bun 1.3.13 on this Mac: `--target=bun-linux-arm64` of `copsd` compiles in 1.1 s after a one-time download of that Bun, output `ELF 64-bit … ARM aarch64 … interpreter /lib/ld-linux-aarch64.so.1` (glibc, 104 MB unstripped, 39 MB gzipped); `--target=bun-darwin-x64` of `cops-hook` → `Mach-O 64-bit executable x86_64` with an ad-hoc signature. Native darwin-arm64 `cops` is `flags=0x20002(adhoc,linker-signed)`, 66 MB, 23 MB gzipped. | Four targets from one runner are feasible; the WASM travels unchanged. Ship `.tar.gz` (≈23–39 MB each). musl variants are not needed for v1. |
| 9 | Bun builds are not byte-reproducible | Two consecutive `bun build --compile` of the same hook here: SHA-256 differ, `cmp -l` shows 33 differing bytes (LC_UUID identical, the difference sits in the embedded bundle tail). | "Reproducible" in the lead's direction is replaced by **CI-built sums plus provenance**: `SHA256SUMS` from the release job and a GitHub artifact attestation per archive; a rebuild-and-compare gate is not offered (S-10). |
| 10 | macOS quarantine and Gatekeeper | Verified here: a `curl -o` download carries `com.apple.provenance` only, **no `com.apple.quarantine`** (Apple Community 256200611: the attribute is set by the downloading app; curl does not). A browser download of an ad-hoc-signed binary is killed by Gatekeeper on Sequoia (exit 137, `spctl` rejected; issues linked in §2 sources). Fix for users: `xattr -d com.apple.quarantine <file>`; real fix: Developer ID signing + notarization (Apple Developer Program, owner action). | `install.sh` downloads with curl, so the binaries run as-is; it still strips the attribute if present and prints the `xattr -d` line for browser downloads. The release workflow signs with Developer ID and notarizes **only when the secrets exist**, else ad hoc (S-10). |
| 11 | launchd user agents | `launchd.plist(5)`: `Label` "required key"; `RunAtLoad` default false; `KeepAlive` "kept continuously running"; `ThrottleInterval` "jobs will not be spawned more than once every 10 seconds"; `ExitTimeOut` SIGTERM→SIGKILL delay; `EnvironmentVariables`, `StandardOutPath`, `StandardErrorPath`, `WorkingDirectory`, `ProcessType` (Background); "~/Library/LaunchAgents — Per-user agents provided by the user". thrysoee.dk/launchctl and ss64: `load`/`unload` are deprecated; use `launchctl bootstrap gui/$UID <plist>`, `bootout gui/$UID/<label>`, `kickstart -k gui/$UID/<label>`, `print gui/$UID/<label>`. | §7.3 plist: `ProgramArguments` absolute, `KeepAlive: { SuccessfulExit: false }`, `RunAtLoad`, `ProcessType Background`, `ExitTimeOut 10`, logs in `~/.jev-cops/copsd.log`, `PATH` set explicitly (launchd's is `/usr/bin:/bin:/usr/sbin:/sbin`). |
| 12 | systemd user units | `systemd.unit(5)`, `systemd.service(5)`, `loginctl(1)` (freedesktop.org answered 403 from this sandbox; not re-fetched, cited from the man pages): units in `~/.config/systemd/user/`; `systemctl --user daemon-reload`, `enable --now`, `disable --now`, `status`; `loginctl enable-linger $USER` keeps user services running without a login session; specifiers `%h` (home), `%t` (`$XDG_RUNTIME_DIR`); user services inherit no shell `PATH`. | §7.3 unit: `ExecStart=` absolute, `Restart=on-failure`, `RestartSec=2`, `KillSignal=SIGTERM`, `TimeoutStopSec=10`; `cops service install` runs `daemon-reload` + `enable --now`; linger is offered, never forced (it changes when the daemon runs). |
| 13 | GitHub artifact attestations, npm provenance | docs.github.com "Using artifact attestations": permissions `id-token: write`, `contents: read`, `attestations: write`; `uses: actions/attest-build-provenance` with `subject-path`; verify with `gh attestation verify PATH -R OWNER/REPO`; offline verification exists. npm provenance (`npm publish --provenance`) is documented for public packages built on GitHub Actions/GitLab with OIDC. | §7.1. Attestations on a **private** repo may need a paid plan — the repo is private today; the release job attests when it can and never fails the release on it. |
| 14 | Claude Code skill, plugin and MCP surfaces | code.claude.com/docs/en/skills: personal `~/.claude/skills/<name>/SKILL.md`, project `.claude/skills/`, nested `<subdir>/.claude/skills/`, enterprise `.claude/skills/` inside the managed settings dir (`/etc/claude-code/.claude/skills/<name>/` on Linux), plugin `<plugin>/skills/`, `~/.claude/skills/synced/` (downloaded from claude.ai), `.claude/commands/` "merged into skills"; "A skill can grant itself broad tool access, so review the `allowed-tools` of skills checked into a repository"; "Workspace trust doesn't gate this field". plugins/loading: root `~/.claude/plugins` (or `CLAUDE_CODE_PLUGIN_CACHE_DIR`): `cache/<marketplace>/<plugin>/<version>/`, `marketplaces/<name>/`, `synced/`, `installed_plugins.json`, `known_marketplaces.json`; a `.claude-plugin/plugin.json` under a skills dir loads as a plugin "so it can bundle agents, hooks, and MCP servers". plugins/install: `claude plugin install <name>@<marketplace> [--scope user|project|local] [--yes]`, `claude plugin marketplace add <owner/repo | git URL | ./path | https://…/marketplace.json>`, `/plugin install`, `--plugin-dir`; "Whatever the tier, a plugin you install can run code with your user privileges"; `command` sources "install by running a command". mcp: `claude mcp add [--scope local|project|user] <name> <url | -- cmd…>`, local/user in `~/.claude.json`, project in `.mcp.json`; `claude mcp add-json`. | The `skill-install` surfaces of §5 and the install-scan roots of §4.4. `~/.claude/plugins/` is kill-tier in `config-trees.ts` today (D-073); a plugin install through `claude plugin install` is a `harness-config` CLI (D-072 → hold). The scanner scans what the CLI fetched (`cache/…`) after the fact (§4.3 post-install scan). |
| 15 | Pi packages | pi.dev/docs/latest/packages: `pi install npm:@example/pi-tools@1.0.0`, `pi install git:github.com/example/pi-tools@v1`, `pi install ./local-package`; "Personal installs are written to `~/.pi/agent/settings.json`"; `pi list`, `pi remove <source>`, `pi update --extensions`; "Packages can execute extension code"; skills can "instruct the model to run programs". `docs/PI_EXTENSION.md` (SkillSpector): `pi install /path/to/SkillSpector` registers a `skillspector_scan` tool, `noLlm` default true. | `pi install` is a skill-install surface; `~/.pi/agent/` subtrees (`extensions`, `skills`, `git`, `npm`) are install roots. |
| 16 | Other harnesses and the universal dir | vercel-labs/skills README: `npx skills add <owner/repo> [-g] [--agent …] [--copy]`, symlinks by default; path table: Claude Code `.claude/skills/` / `~/.claude/skills/`; Pi and others `.agents/skills/` / `~/.agents/skills/`; Amp/universal `~/.config/agents/skills/`. Codex `~/.codex/skills/`, `.codex/skills/`; OpenCode `.opencode/skills/`, `~/.config/opencode/skills/` (secondary sources; re-verify in M3, like D-072). | `.agents/skills`, `~/.agents/skills`, `~/.config/agents/skills` join the skill trees (annotate-tier entries, not config-tamper's). |

Sources: NVIDIA/SkillSpector `README.md`, `pyproject.toml`, `src/skillspector/cli.py`,
`docs/SC4-osv-live-vulnerability-lookups.md`, `docs/ANALYSIS_RESOURCE_BOUNDS.md`,
`docs/PI_EXTENSION.md`, `docs/OPENCODE_EXTENSION.md` (main, 2026-09-30);
docs.nvidia.com/skills/scanning-agent-skills; snyk/agent-scan `README.md`, `docs/cli-reference.md`;
cisco-ai-defense/skill-scanner `README.md`, `docs/getting-started/quick-start.md`;
bun.com/docs/bundler/executables; developer.apple.com (notarization; page fetch blocked, cited
from the title and the community thread); keith.github.io/xcode-man-pages/launchd.plist.5;
thrysoee.dk/launchctl; ss64.com/mac/launchctl; docs.github.com artifact attestations;
code.claude.com/docs/en/{skills,plugins,plugins/install,plugins/loading,mcp}; pi.dev/docs/latest/packages;
vercel-labs/skills README; GitHub issues mesutoezdil/accel#24, yfedoseev/crgx#12 (quarantine).

**What changed the lead's direction:** (a) static mode still talks to OSV.dev (row 3) — the wizard
and the docs say "dependency names leave, contents do not" instead of "nothing leaves"; (b) a scan
does not fit the 12 s deadline in general (row 5) — two-phase is the design, not a fallback;
(c) SkillSpector is not on PyPI and has no published image (row 1) — "documented install commands"
means `uv tool install git+…` or a local `docker build`, both needing `git`; (d) Bun builds are not
reproducible (row 9) — sums + attestations, no rebuild gate; (e) the D-104 Ed25519 key is a
per-deployment audit key generated by users, so it cannot sign releases — GitHub attestations
(Sigstore keyless) do (S-10); (f) exit code 1 is a verdict (row 2); (g) on the npm path the hook must
still be a compiled binary (S-3, §7.2): a `#!/usr/bin/env bun` shim depends on `bun` being on the
PATH Claude Code's hooks inherit, and "a hook that can't start … leaves the gate silently disabled"
(PLAN-M1 §2 row 3).

## 3. Build order with gates and file ownership

Concurrent work: M2 step 0 (`policies/_lib/*`, `config-tamper.*`, core loader) on master; M2 steps
1–4 (`packages/openshell/`, `packages/daemon/src/{openshell,jit}.ts`, `[openshell]` in `config.ts`);
M2 step 5 (`packages/daemon/src/audit-forward/`, `audit.ts`, `cops keygen`, `cops audit verify`,
doctor audit checks) in a worktree; the npm agent (every `package.json`, `packages/policies/`,
`bin` fields, `[policies] dir` default). This track never edits those files except where a step
says "one line", and lands those lines after the owning step is merged.

| # | Step | Owns (new unless marked) | Gate |
|---|---|---|---|
| S0 | `@jev-cops/scanner` package: contract + adapters + fake | `packages/scanner/src/{types,index,run,materialize,parse}.ts`, `src/adapters/{none,skillspector,command}.ts`, `testing/fake-skillspector.ts`, `testing/fixtures/*.json`, `README.md` (the `command` contract) | contract suite (11 checks × 3 adapters, like the judge's) on the fake; no network; the fake binary is a Bun script the tests build with `--compile` once |
| S1 | core + SDK: `ScanView`, skill-install detection, fixtures | `packages/core/src/policy/scan.ts` (types + `noScan`), `packages/core/src/normalizer/install-verbs.ts` (CLI verbs `skill-install`), `packages/core/src/policy/types.ts` (**one field** `ctx.scan`), `context.ts` (one line), `packages/sdk/src/fixtures.ts` + `runner.ts` (case field `scan`), `policies/_lib/skill-trees.ts`, `policies/skill-install.ts`, `policies/skill-install.fixtures.json` (wherever `@jev-cops/policies` puts the starter set) | `bun run gate` 7 policies; the 6 existing fixture files byte-identical in outcome; `skill-install` fixtures (§5) alone and with the set. Lands after M2 step 0 (reuses `config-trees.ts` `canon`, `projectRoots`) |
| S2 | daemon scan gate + cache + config | `packages/daemon/src/scan-gate.ts`, `scan-cache.ts` (SQLite `scan_results`), `scanner-config.ts` (`[scanner]` table + validation); `config.ts` **one key + one import**; `service.ts` **one call** before `engine.judge`; `/v1/health` `scanner` field; `daemon.ts` runtime field | daemon tests with the fake scanner: inline result, pending hold, cached retry, error → hold + anomaly, health. Lands after M2 steps 3 and 5 touch `config.ts` |
| S3 | `cops scan`, doctor `scanner` group, install-scan | `packages/cli/src/commands/scan.ts`, `doctor-scanner.ts`; `doctor-run.ts` **one spread**; `main.ts` one command entry | doctor tests (configured/missing/version/one-shot report); `cops scan` on the fixtures, `--json` = `jev-cops.scan/1` |
| S4 | `cops service` | `packages/cli/src/commands/service.ts`, `packages/cli/src/service/{launchd,systemd,units}.ts`, goldens under `packages/cli/src/service/fixtures/` | golden plist/unit byte-identical; `launchctl`/`systemctl` argv recorded on a fake runner; never loaded in tests |
| — | *(session boundary suggested: stop and report)* | | |
| S5 | `cops setup` | `packages/cli/src/commands/setup*.ts` (`setup-args`, `setup-detect`, `setup-questions`, `setup-plan`, `setup-apply`, `setup-undo`, `setup-render`), `packages/cli/src/prompt.ts` (line reader over an injected stdin), `packages/cli/src/toml-edit.ts` (generalizes `toml-key.ts` without editing it), `packages/cli/src/testing/setup-world.ts` | wizard tests with scripted stdin + temp `HOME` + fake `claude`/`uv`/`skillspector`/`launchctl`; `--yes` matrix; `--dry-run` writes nothing (the refusing fs of `install-world.ts`); interrupt at every step then re-run converges; `--uninstall` leaves audit + keys |
| S6 | distribution | `install.sh` (repo root), `scripts/release/{build-all.sh,checksums.sh}`, `.github/workflows/release.yml`, `scripts/release/install-sh.test.ts` (fake release server), `packaging/homebrew/jev-cops.rb.tmpl` (later, not wired) | `install.sh` test: temp prefix, wrong sum refused, wrong arch refused, PATH hint, quarantine strip; workflow lint (`actionlint`) in CI; a local dry run of `build-all.sh` produces the four archives |
| S7 | docs + capture | `README.md` quickstart (rewrite of "Quickstart" and "Install"), `docs/setup.md` (user guide), `docs/scanners/{contract,skillspector,snyk-agent-scan,cisco-skill-scanner}.md`, `docs/adapters.md` (skill surfaces), `docs/captures/setup.md`, STATUS, DECISIONS rows | captured first run reviewed; timing under two minutes |

S0, S4 and S6 have no dependency on M2 or on each other and can start now. S1 after M2 step 0;
S2 after M2 steps 3 and 5 (config.ts); S3 after M2 step 7 (doctor groups) or with a one-line
merge; S5 after S2–S4. `policies/_lib/judge-guard.ts` gains `cops setup`, `cops service` and
`cops scan --accept` in its held-CLI list — one array entry, landed with or after D-114.

## 4. Module map and interfaces

### 4.1 `@jev-cops/scanner` (`packages/scanner`)

```ts
// types.ts
export type ScanVerdict = "safe" | "caution" | "unsafe" | "error";
export interface ScanFinding { id: string; severity: "low" | "medium" | "high" | "critical"; title: string;
  file?: string; line?: number }
export interface ScanResult {
  verdict: ScanVerdict; score: number | null;          // 0..100 as the tool reports it; null when it has none
  findings: readonly ScanFinding[];                    // ≤ 64 kept, sorted by severity; the rest counted
  truncated: number; tool: string; version: string | null; mode: "static" | "llm";
  durationMs: number; error: string | null;            // verdict "error" only; one bounded line
  network: "none" | "osv-only" | "provider";           // what the adapter knows left the machine
}
export type ScanTarget = { kind: "dir"; path: string } | { kind: "file"; path: string }
  | { kind: "url"; url: string; fetchedBy: "daemon" };  // the scanner never fetches (§4.3)
export interface ScanOptions { deadlineMs: number; signal?: AbortSignal; env?: Env; cwd?: string }
export interface Scanner {
  readonly name: "none" | "skillspector" | "command";
  available(): Promise<{ ok: true; version: string | null } | { ok: false; reason: string }>;
  scan(target: ScanTarget, opts: ScanOptions): Promise<ScanResult>;   // never throws; error → verdict "error"
}
// index.ts — mirrors @jev-cops/judge createJudge: never throws at startup; a missing binary yields a
// scanner whose scan() answers { verdict: "error", error: "skillspector not found on PATH" }
export type ScannerConfig =
  | { adapter: "none" }
  | { adapter: "skillspector"; binary?: string; docker?: { image: string } | null; mode?: "static" | "llm"; extraArgs?: string[] }
  | { adapter: "command"; argv: string[]; mode?: "static" | "llm"; network?: ScanResult["network"] };
export function createScanner(c: ScannerConfig, deps?: { spawn?: Spawn; env?: Env; which?: Which }): Scanner;
```

`run.ts`: one bounded process per scan — exec form (no shell), cwd = the materialized dir, env =
`PATH`, `HOME`, `LANG`, `TMPDIR` plus, for `mode: "llm"` only, the documented `SKILLSPECTOR_*` and
provider key variables from the daemon's env (never from config, D-044), `SKILLSPECTOR_MAX_WORKFLOW_SECONDS
= ceil(deadlineMs/1000)`, `SKILLSPECTOR_LOG_LEVEL=ERROR`; stdout capped at 4 MiB (more → `error`),
stderr kept as the last 2 KB for the audit line; the process group is killed at the deadline
(`error: "timeout"`). `parse.ts`: strict zod schemas per adapter (unknown fields ignored, required
ones validated; any miss → `error: "unreadable scanner output"`), finding titles flattened to one
line ≤ 200 chars, prompt-like text flagged as D-050 does.

`skillspector` adapter: argv `[binary, "scan", <path>, "--format", "json"]` + `--no-llm` unless
`mode: "llm"`; Docker form `["docker", "run", "--rm", "--network", "none"?, "-v", "<dir>:/scan:ro", image, "scan", "/scan", "--format", "json", "--no-llm"]`
— `--network none` is **not** used by default (it would silence OSV and the tool still degrades
gracefully; `[scanner.skillspector] docker_network = "none"` is the air-gapped option). Exit 0/1 +
JSON → `recommendation` map `SAFE → safe`, `CAUTION → caution`, `DO_NOT_INSTALL → unsafe`; exit 2
or no JSON → `error`; `metadata.llm_requested && !llm_available` → `error` (a requested LLM pass that
silently did not run must not read as a clean static scan). `available()` runs `<binary> --version`
(2 s). `command` adapter: runs `argv + [path]`, expects the `ScanResult` JSON of
`docs/scanners/contract.md` on stdout (schema `jev-cops.scan/1`), exit code ignored except for a
spawn failure. `none`: `available()` ok; `scan()` is never called — the daemon's gate reports
`status: "none"` and the policy maps "no scanner" to `annotate`, never to a false `safe` (§5).

`materialize.ts`: builds the directory the scanner sees, under `~/.jev-cops/scan/<sha256>/` (0700,
private path, D-098, removed after the scan unless `[scanner] keep = true`): a `Write` → the file at
its relative name inside the skill dir it targets, plus the skill dir's current siblings copied
(no symlink following, 1 MiB per file, 100 files); an `Edit`/`NotebookEdit` → the current file with
`old → new` applied (the daemon reads the file the agent is about to change); a `Bash` write the
normalizer proved (`cp`, `tar -x`, `unzip`, `git clone`) → the source path when local and readable,
the URL when remote. Content hash = SHA-256 over the sorted `relative path\0bytes\0` sequence. A
remote source is fetched **by the daemon**, never by the scanner: `git clone --depth 1` through the
hardened runner of D-067 (no credential helpers, `GIT_TERMINAL_PROMPT=0`, `GIT_ALLOW_PROTOCOL=https`,
20 s, 100 MiB cap, commit recorded), zips downloaded with `fetch` under the same caps; `ssh://`,
`git@`, private hosts or a failure → no fetch, verdict `error: "remote source not fetched"` (→ hold,
the prompt names `cops scan <url>`).

### 4.2 Core and SDK

```ts
// core policy/scan.ts — what a policy sees as ctx.scan (frozen)
export interface ScanView {
  readonly status: "none" | "pending" | "done" | "error";   // none: not a skill-install shape or scanner "none"
  readonly result: ScanResult | null;                        // done or error
  readonly targets: readonly { readonly path: string; readonly surface: SkillSurface }[];  // what was scanned
  readonly cached: boolean;
}
export type SkillSurface = "claude-skill" | "claude-plugin" | "claude-command" | "claude-agent" | "mcp-config"
  | "pi-package" | "pi-extension" | "agents-skill" | "codex-skill" | "opencode-skill" | "cli-install";
export function skillInstallTargets(e: PolicyEvent, roots: TreeRoots): { path: string; surface: SkillSurface }[];
// engine.judge(event, cf, { home, repoHints?, scan? })  — `scan` defaults to noScan()
```

`install-verbs.ts` (normalizer): `claude plugin install|marketplace add|enable`, `claude mcp add|add-json`,
`npx|bunx|pnpx skills add|use`, `pi install`, `codex …`/`opencode …` skill subcommands (M3, from
general knowledge), `git clone` whose destination is under a skill root → verb `skill-install`
(in addition to D-072's `harness-config` where it applies) with the source as a target. SDK fixture
case field `scan?: ScanResult` (recorded, like `answers`), applied as `ctx.scan.status = "done"`.

### 4.3 Daemon scan gate (`packages/daemon/src/scan-gate.ts`)

Runs in `judgeEvent` before `engine.judge`, only for `pre` events whose normalized form has a
skill-install target (`skillInstallTargets`, cheap); everything else pays nothing.

1. **Cache lookup** (`scan_results`: `content_sha256, tool, tool_version, mode, verdict, score,
   findings_json, network, scanned_at, expires_at, accepted_by`): hit and not expired → `ScanView
   { status: "done", cached: true }`. TTL `[scanner] cache_ttl_ms` (7 days); a `cops scan --accept
   <hash>` (human, local CLI, admin socket) records an `accepted_by` row that turns `caution` into
   `safe` for that hash only — the precedent-like override, never for `unsafe`.
2. **Materialize** (≤ 200 ms budget for local content; remote fetch always goes to step 4).
3. **Inline scan** with `min(inline_ms, deadline_left − 3000)`: done → `status: "done"`, cached.
4. **Two-phase**: not done in time (or a remote fetch) → the scan continues detached (bounded by
   `deadline_ms`, at most `max_concurrent` (2) scans; more → `error: "scanner busy"`), the view is
   `status: "pending"` and the policy holds; the result lands in the cache and the retry of the same
   content is served from step 1. The audit `judge` line carries `scan: { status, hash, tool,
   durationMs, verdict?, score?, findings_count, network }`; a `scan` line is appended when a
   detached scan finishes (never the findings text beyond 64 titles).
5. **Post-install scan** (report only): a Claude Code `config-change` with `config_source: "skills"`
   and a `file_path`, or a `post` event of a `harness-config`/`skill-install` CLI, schedules a scan of
   the installed directory; an `unsafe` result writes an `anomaly` line and sets a per-root note
   that the next verdict of that session carries as `context_note` ("SkillSpector rated the skill
   you installed DO_NOT_INSTALL: <first finding>; run `cops scan <path>`"), and `cops doctor` fails
   on it until `--accept`ed or the directory changes.

Under OpenShell (M2) the gate runs on the host exactly as here: the scanner's network is copsd's,
the sandbox has no route to OSV or a provider (T13 reasoning of PLAN-M2 §7). The gate never runs
inside the sandbox and never uses the agent's env.

### 4.4 CLI

```text
cops scan <path|url> [--json] [--adapter skillspector|command|none] [--llm] [--accept] [--timeout 60s]
cops service install|uninstall|start|stop|restart|status|logs [--home dir] [--dry-run] [--json]
cops setup [--yes] [--dry-run] [--uninstall] [--harness claude-code,pi] [--enforcement observe|enforce]
           [--judge off|jev|openrouter|vercel-ai] [--scanner none|skillspector|command:<argv>]
           [--install-scanner uv|docker|no] [--service|--no-service] [--sign|--no-sign]
           [--syslog host:port --syslog-ca path | --no-syslog] [--scan-installed|--no-scan-installed]
           [--prefix dir] [--home dir] [--json]
```

`cops scan` needs no daemon: it builds the scanner from the config (`--adapter` overrides), scans,
prints the findings in the D-096 style plus the score (a human at a terminal, not a transcript),
exit 0 safe, 1 caution, 2 unsafe, 3 error. `--accept` writes the cache row through the admin socket
when copsd runs, else directly into the store. Doctor group `scanner`: configured adapter, binary or
image present, `--version`, a 5 s self-test on the bundled `safe_skill` fixture, cache size, pending
scans older than `deadline_ms`, the post-install `unsafe` notes; with `--scan-installed` (default in
`cops setup`, off in `doctor`) one pass over every install root of §5 for the detected harnesses,
reported as `warn` per `caution`, `fail` per `unsafe`, never blocking anything.

## 5. `skill-install` policy

```ts
// policies/skill-install.ts (imports @jev-cops/sdk and ./_lib/skill-trees.ts only)
name: "skill-install", version: 1, owner: "cyber-team", range: ["annotate", "deny"], fallback: "hold"
when:   skillInstallTargets(e, roots).length > 0            // a non-read access under a skill root, or a skill-install verb
decide: ctx.scan.status === "none"    → "annotate"           // no scanner configured: "run cops setup to add one"
        ctx.scan.status === "pending" → "hold"               // "scan pending: retry in a few seconds"
        ctx.scan.status === "error"   → "hold"               // scanner missing, timeout, garbage, remote not fetched
        result.verdict === "unsafe"   → ctx.config.scanUnsafe ("deny" default, "kill" allowed, tighten-only)
        result.verdict === "caution"  → "hold"
        result.verdict === "safe"     → "annotate"           // never lowers config-tamper's hold on ~/.claude/skills (monotonic)
reason: "Installing <name> was rated <SAFE|CAUTION|DO NOT INSTALL> by <tool> (<n> findings)."  // agent-safe, no score
detail (confirm summary, D-096): "<tool> <version>, static scan: <n> findings — <sev> <title> (<file>:<line>); …" ≤ 5 lines,
        plus "dependency names were checked against OSV.dev" when network = osv-only; never the score
contextNote (annotate): "jev-cops scanned <name> with <tool>: no findings." | "no scanner configured; cops setup adds one"
```

Skill trees (`policies/_lib/skill-trees.ts`, same shape as `config-trees.ts`, anchored `home` /
`project` / `absolute`): Claude Code `~/.claude/skills`, `~/.claude/plugins/{cache,marketplaces,synced}`,
`.claude/skills`, `.claude/commands`, `.claude/agents`, `<managed>/.claude/skills`; Pi `~/.pi/agent/{skills,extensions,git,npm}`,
`.pi/{skills,extensions}`; universal `~/.agents/skills`, `~/.config/agents/skills`, `.agents/skills`;
Codex `~/.codex/skills`, `.codex/skills`; OpenCode `~/.config/opencode/skills`, `.opencode/skills`;
MCP: `.mcp.json`, `~/.claude.json` (`mcpServers` edits: the scan target is the server's `command`
package when it is a local path; a remote `url` is not scanned — `hold` by config-tamper stands and
the note says so). The trees never lower a `config-tamper` tier; `skill-install` adds evidence and
a `deny`, never an allow.

Why `unsafe → deny`, not `kill`: `kill` latches the session and ends it (D-076) for exfil and
config tampering that are certain by construction; a static scanner has "moderate precision (some
false positives)" (README) and a false positive must not end a session — `deny` returns the reason,
the human runs `cops scan` and can `--accept`. Teams that want it can set `[scanner] unsafe = "kill"`
(repo override may only raise it, D-048). Why the score stays out of the prompt: D-096's reason
holds unchanged (the transcript is agent-readable); the recommendation word and the finding titles
are what the human needs; the score is in the audit line and `cops explain`.

**Fixtures (`skill-install.fixtures.json`, ≥ 16, each with a recorded `scan`):** Write
`~/.claude/skills/x/SKILL.md` + scan unsafe → deny · same + caution → hold with the findings in the
summary · same + safe → hold (config-tamper's hold stands; `policies` lists both) · Write
`.agents/skills/x/SKILL.md` + safe → annotate · same + no scan (`status: none`) → annotate "no scanner
configured" · same + pending → hold · same + error → hold · Bash `npx skills add o/r` + pending → hold
· `pi install git:github.com/o/r` + unsafe → deny · `claude plugin install x@m` + none → hold
(config-tamper `harness-config`) · `git clone https://… ~/.claude/skills/y` + caution → hold ·
Edit `.mcp.json` + safe → hold (config-tamper) · `cp -r /tmp/skill ~/.codex/skills/` + unsafe → deny ·
Write `~/.claude/skills/x/README.md` (not SKILL.md, still under the root) + safe → hold · Read of
`~/.claude/skills/x/SKILL.md` → no match · Write `src/skills.ts` in the repo → no match · unsafe with
`config.policy.scanUnsafe = "kill"` → kill · observe mode: deny becomes allow with the "would have"
note (daemon test).

## 6. `cops setup`

Principles: detect, then ask, then show the whole plan, then a single yes; every action is
idempotent and journaled (`~/.jev-cops/setup.json`: what was created, by which version, when) so a
re-run shows only deltas and `--uninstall` removes exactly what was created; nothing is executed or
written before the plan is confirmed (`--yes` confirms every question with its default or the flag);
third-party installs run only after their own explicit yes (never under `--yes` unless
`--install-scanner uv|docker` was passed); `--dry-run` prints the plan and exits 0.

Order of application (chosen for fail-closed, §8): 1 write `~/.config/jev-cops/cops.toml` →
2 `cops keygen` → 3 compile `cops-hook` when running from the npm package (§7.2) → 4 `cops service
install` and wait for `/v1/health` on both sockets (≤ 10 s) → 5 `cops install <harness>` for each
chosen harness (existing M1 code, with the offline canary) → 6 scanner install (if asked) →
7 `cops doctor` (+ one-shot installed-skills scan) → 8 print what to do next. Hooks are installed
only after the daemon answers, so a service that fails to start never leaves a fail-closed hook
blocking the user's harness.

**Questions, in order, with defaults** (a detected fact is shown, not asked):

| # | Question | Default | Notes |
|---|---|---|---|
| 1 | Harnesses to protect: `[x] Claude Code (claude 2.1.285 at /opt/homebrew/bin/claude)  [ ] Pi (not found)  Codex, OpenCode: coming in M3` | every detected harness | detection: binary on PATH, `~/.claude`/`$CLAUDE_CONFIG_DIR`, `~/.pi/agent`; none detected → still offers both, warns |
| 2 | Enforcement: `observe` / `enforce` | `observe` | "observe: every call is judged and logged, nothing is blocked; the boot line and doctor warn until you switch. enforce: hold asks you, deny blocks. Start in observe for a week, then `cops setup --enforcement enforce`." (spec M4, D-047) |
| 3 | Semantic judge: `off` / `jev` / `openrouter` / `vercel-ai` | `off` | "The judge answers typed questions only when a policy asks; the key is read from `$TYPESAFE_API_KEY` / `$OPENROUTER_API_KEY` at daemon start, never stored (D-044). Not set now: the daemon runs with the judge disabled and doctor says so." `vercel-ai` needs a model module: printed, not asked |
| 4 | Security scanner for skills, plugins and MCP servers the agent installs: `none` / `skillspector` (NVIDIA, static by default) / `command` (your own, prints jev-cops.scan/1) | `none` | shown as "recommended: skillspector" when `uv` or `docker` is present. Static mode text: "runs on this machine, never runs the skill; dependency names and versions are checked against OSV.dev; file contents leave the machine only if you enable LLM mode later (`[scanner] mode = "llm"`)." |
| 4a | SkillSpector not found. Install it? `uv tool install git+https://github.com/NVIDIA/skillspector.git` (needs uv, git, Python 3.12–3.14) / `docker build -t skillspector <clone>` / `no, I will install it` | `no` | the exact command is printed before the yes; `uv` missing → the two documented `uv` install lines are printed, never run; `no` → the config still names skillspector and doctor fails until it is present (fail closed: skill installs are held meanwhile, §8) |
| 5 | Sign the audit log with a new Ed25519 key (`cops keygen`)? | `yes` | D-104; prints where the public key goes ("hand `~/.config/jev-cops/audit-ed25519.pub` to your cyber team"); skipped with a warning when the key exists |
| 6 | Forward audit lines to syslog over TLS? `host:port` + CA path | `no` | D-103; asked only when 5 was answered; validation is the M2 step 5 config's |
| 7 | Run `copsd` as a login service (launchd agent / systemd --user)? | `yes` | `no` → prints the `copsd` line to run by hand and continues; on Linux without a login session offers `loginctl enable-linger` as a separate yes |
| 8 | Scan the skills and plugins already installed, once, and report? | `yes` when a scanner was chosen | never blocks; output goes to the terminal and the audit line |
| 9 | Plan shown; `Apply? [y/N]` | — | `--yes` answers y |

**Transcript mock (first run, macOS, Bun path):**

```text
$ bunx jev-cops setup
jev-cops 0.1.0 setup — nothing is written before you say yes.

Detected: Claude Code 2.1.285 (/opt/homebrew/bin/claude, ~/.claude) · Pi: not found · Bun 1.3.13 · uv 0.9.3 · docker 29.4
  jev-cops is running from bunx's cache; it will be installed globally (bun add -g jev-cops) so hooks and the service have a stable path.

1. Harnesses  [x] Claude Code  [ ] Pi  (Codex, OpenCode: coming in M3)          › Enter
2. Enforcement  (observe) enforce
   observe judges and logs every call and blocks nothing; switch later with `cops setup --enforcement enforce`.   › Enter
3. Semantic judge  (off) jev  openrouter  vercel-ai
   Keys are read from the environment at daemon start, never stored.               › Enter
4. Security scanner for skills, plugins and MCP servers  none  (skillspector)  command
   skillspector: static scan on this machine, the skill never runs; dependency names go to OSV.dev; contents stay local.   › Enter
   skillspector is not installed. Install it now?
     [1] uv tool install git+https://github.com/NVIDIA/skillspector.git   (uv 0.9.3, Python 3.14.2, git found)
     [2] docker build -t skillspector <clone of NVIDIA/SkillSpector>
     [3] no, I will install it myself (skill installs are held until it is present)          › 1
5. Sign the audit log with a new Ed25519 key?  (yes) no                             › Enter
6. Forward audit lines to syslog over TLS?  yes (no)                                › Enter
7. Run copsd as a login service (launchd agent)?  (yes) no                          › Enter
8. Scan the 3 skills already under ~/.claude/skills once and report?  (yes) no      › Enter

Plan
  write   ~/.config/jev-cops/cops.toml           enforcement observe · judge off · scanner skillspector (static) · audit signed
  create  ~/.jev-cops/keys/audit-ed25519.key (0600) and ~/.config/jev-cops/audit-ed25519.pub
  build   ~/.local/libexec/jev-cops/cops-hook    (bun build --compile of the installed package, ~1 s, 64 MB)
  write   ~/Library/LaunchAgents/dev.jev-cops.copsd.plist · launchctl bootstrap gui/501 · wait for /v1/health
  run     uv tool install git+https://github.com/NVIDIA/skillspector.git
  edit    ~/.claude/settings.json                (+5 hook entries, backup kept) · offline canary
  run     cops doctor --scan-installed
Apply? [y/N] y

✓ cops.toml written            ✓ audit key created (public key: ~/.config/jev-cops/audit-ed25519.pub)
✓ cops-hook built 0.1.0        ✓ copsd running (launchd, pid 4123, ~/.jev-cops/copsd.sock)
✓ skillspector 2.12.0 installed (uv)   ✓ Claude Code hooks installed (user scope) · canary: deny as expected
doctor: 31 ok · 2 warn (enforcement observe; judge off) · 0 fail · 23 gaps printed · installed skills: 3 safe
Done in 1m41s. Next: `cops setup --enforcement enforce` when you trust the verdicts; `cops doctor` any time.
```

`--uninstall`: reads the journal, then in reverse: `cops install --uninstall` per harness (existing),
`cops service uninstall`, removes the built hook, the scan cache dir, `cops.toml` (backup
`cops.toml.jev-cops-<ms>.bak`), and asks about the global npm package; **keeps** `~/.jev-cops/audit.jsonl`,
`cops.sqlite` and the keys (they verify old logs) and prints their paths. Third-party tools are
never uninstalled (prints `uv tool uninstall skillspector`).

## 7. Distribution

### 7.1 Release workflow (`.github/workflows/release.yml`, `workflow_dispatch`)

Inputs `tag` (vX.Y.Z), `publish_npm` (bool, default false), `draft` (bool, default true).
Jobs: **build** matrix `{ubuntu-latest: linux-x64, linux-arm64; macos-latest: darwin-arm64, darwin-x64}`
(darwin targets on the macOS runner so the Mach-O ad-hoc signature is the linker's, and so a
Developer ID + notarization step can run there when `APPLE_*` secrets exist; else ad hoc), each
running `bun install --frozen-lockfile`, `scripts/release/build-all.sh <target>` (three
`bun build --compile --target … --minify`), a native smoke on the runner's own target
(`cops --version`, `cops test <policies>`, `cops-hook --version`), `tar -czf jev-cops-<tag>-<target>.tar.gz cops copsd cops-hook`;
**checksums** job downloads all four, writes `SHA256SUMS`, runs `actions/attest-build-provenance`
on each archive and on `SHA256SUMS` (continue-on-error: private repos may not be entitled),
and `gh release create <tag> --draft --verify-tag` with the archives, `SHA256SUMS`, `install.sh`;
**npm** job (only with `publish_npm`, needs `NPM_TOKEN` or trusted publishing): `bun pm pack` each
workspace in dependency order (`core`, `sdk`, `judge`, `scanner`, `policies`, `daemon`, adapters,
`cli`, `jev-cops`), then `npm publish <tgz> --provenance --access public` — provenance is an npm-CLI
feature (public packages, GitHub OIDC); verify whether `bun publish` has grown `--provenance` before
swapping. Version = the tag; `CLI_VERSION`/`DAEMON_VERSION`/`HOOK_VERSION` are read from
`package.json` at build (one-line change in `version.ts`, owned by the npm agent — coordinate).
CI (`ci.yml`) adds `actionlint` and a `build-all.sh darwin-arm64` dry run on macOS.

### 7.2 The npm path and the hook binary

`bun add -g jev-cops` puts `cops`, `copsd`, `cops-hook` shims in `~/.bun/bin` (scripts with
`#!/usr/bin/env bun`); `npm i -g` does the same in npm's bin dir. `cops` and `copsd` are started by
a human or by the service unit with an absolute `bun` path, so shims are fine there. The hook is
not: Claude Code spawns it with the environment it inherited (a GUI launch has no `~/.bun/bin` on
PATH), and a hook that cannot start fails **open** (PLAN-M1 §2 row 3). So `cops setup` (and
`cops install claude-code` when it detects it runs from a package: `Bun.main` not under `/$bunfs/`,
`hook-binary.ts` `isCompiled`) builds `~/.local/libexec/jev-cops/cops-hook` with `bun build --compile`
from the installed `@jev-cops/adapter-claude-code` entry (≈1 s, 64 MB, no network: same target as
the running Bun), verifies `--version` equals the CLI's (D-091), records it as `[daemon] hook_binary`
(protected, D-082). An upgrade of the package changes the version → doctor fails "hook 0.1.0, cli
0.2.0" → `cops setup` rebuilds (S-3). `bunx jev-cops setup` runs from bunx's cache, whose path is
not stable across versions: the wizard's first action is `bun add -g jev-cops` (shown, yes required)
and it re-execs the global `cops setup` with the same answers.

On the npm path the daemon also protects its own package root (`…/node_modules/jev-cops` and the
`@jev-cops/*` it resolves) the way it protects the compiled binary (S-4): the agent can write
there as the user, and an edited `@jev-cops/daemon` would load at the next restart.

### 7.3 `install.sh` (no-Bun path) and service units

`install.sh` (POSIX sh, `set -eu`, no `eval`, no sudo): `uname -s`/`-m` → target (else exit 1 with
the four supported names); `VERSION` (`--version vX.Y.Z` or `latest` via the GitHub API);
downloads `jev-cops-<v>-<target>.tar.gz` and `SHA256SUMS` from
`${JEV_COPS_RELEASE_BASE_URL:-https://github.com/FrancoisChastel/jev-cops/releases/download/<v>}`
into a temp dir; verifies with `sha256sum -c` or `shasum -a 256 -c` (either must exist, else exit 1);
optional `--verify-provenance` runs `gh attestation verify … -R FrancoisChastel/jev-cops` when `gh`
is present; extracts into `${PREFIX:-$HOME/.local}/bin` (`--prefix`), `chmod 0755`, strips
`com.apple.quarantine` when present (`xattr -d`, macOS only, never fails the install), prints a
PATH hint when the dir is not on PATH, then runs `cops setup` unless `--no-setup`. The recommended
invocation downloads the script first (`curl -fsSLO …/install.sh && sh install.sh`); the
`curl | sh` one-liner is documented as equivalent with a note that it is the SC2 pattern scanners
flag — read the script.

```xml
<!-- ~/Library/LaunchAgents/dev.jev-cops.copsd.plist (golden, paths rendered per machine) -->
<plist version="1.0"><dict>
  <key>Label</key><string>dev.jev-cops.copsd</string>
  <key>ProgramArguments</key><array><string>/Users/me/.local/bin/copsd</string></array>
  <!-- npm path: <string>/Users/me/.bun/bin/bun</string><string>/Users/me/.bun/install/global/node_modules/@jev-cops/daemon/src/main.ts</string> -->
  <key>EnvironmentVariables</key><dict><key>PATH</key><string>/usr/bin:/bin:/usr/sbin:/sbin:/Users/me/.local/bin:/Users/me/.bun/bin:/opt/homebrew/bin</string><key>HOME</key><string>/Users/me</string></dict>
  <key>WorkingDirectory</key><string>/Users/me</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>ExitTimeOut</key><integer>10</integer>
  <key>ProcessType</key><string>Background</string>
  <key>StandardOutPath</key><string>/Users/me/.jev-cops/copsd.log</string>
  <key>StandardErrorPath</key><string>/Users/me/.jev-cops/copsd.log</string>
</dict></plist>
```

```ini
# ~/.config/systemd/user/copsd.service (golden)
[Unit]
Description=jev-cops judging daemon
After=default.target
[Service]
Type=simple
ExecStart=%h/.local/bin/copsd
Environment=PATH=/usr/local/bin:/usr/bin:/bin:%h/.local/bin:%h/.bun/bin
WorkingDirectory=%h
Restart=on-failure
RestartSec=2
KillSignal=SIGTERM
TimeoutStopSec=10
StandardOutput=append:%h/.jev-cops/copsd.log
StandardError=append:%h/.jev-cops/copsd.log
[Install]
WantedBy=default.target
```

`cops service install`: renders, writes atomically (0644 plist, 0600 unit contents are not
secret either), `launchctl bootstrap gui/$UID <plist>` or `systemctl --user daemon-reload && enable
--now copsd`, waits for `/v1/health`; `status` prints `launchctl print` / `systemctl --user status`
digest + the last 20 log lines; `restart` = `kickstart -k` / `systemctl --user restart`;
`uninstall` = `bootout` / `disable --now` + file removal. The log file lives under `~/.jev-cops/`
(protected and private already). The scanner's env for LLM mode comes from the daemon's env: with a
service, that is the unit's `Environment=` — the wizard says keys must be placed there by hand or
the judge/scanner stays disabled (never written by setup, D-044).

Homebrew tap (later, not in this track's gate): `FrancoisChastel/homebrew-jev-cops` with a formula
over the same archives and sums; `packaging/homebrew/jev-cops.rb.tmpl` is generated by the release
job as a starting point.

## 8. Fail-closed analysis

| # | Path | Closed by | Residual |
|---|---|---|---|
| 1 | Scanner configured but missing / not executable / wrong version | `available()` false → every skill-install is `hold` (fallback); doctor `fail`; boot line warns | A user who ignores both; skill installs keep being held, never allowed |
| 2 | Scan slower than the inline budget | two-phase: `hold` "scan pending" now, cached verdict on retry; detached scan bounded by `deadline_ms` and `max_concurrent` | Headless sessions see a `deny` on the first try (D-008) and the real verdict on the retry; printed in the reason |
| 3 | Scanner exits 2, prints no/garbage JSON, exceeds 4 MiB, hangs | `error` → `hold` + `anomaly` line with the last 2 KB of stderr; process group killed at the deadline | — |
| 4 | Scanner exit 1 with valid JSON | a verdict (`unsafe`), never an error (§2 row 2) | — |
| 5 | Findings text aimed at the human or the model | titles flattened and bounded; prompt-like strings flagged (D-050); the agent only ever sees `reason` | The human reads what the scanner wrote |
| 6 | Content differs between scan and install (TOCTOU: marketplace moves, symlinked skill dir) | cache keyed by content hash of what was materialized; remote fetch pinned to a commit and named in the summary; post-install scan of the installed files (§4.3 step 5) | A remote that serves different bytes to the daemon and to the harness is caught post-install only. Printed |
| 7 | Skill installed through a path we do not see (`--plugin-dir`, marketplace `command` source, cloud sync into `~/.claude/skills/synced/`) | post-install scan on `config-change: skills`; `--scan-installed` in setup/doctor; `synced/` is an install root | Report only, no gate. Printed |
| 8 | Setup interrupted after step n | each step idempotent and journaled; re-run resumes; hooks come after a healthy daemon, so an interrupt before step 5 leaves no fail-closed hook without a daemon | An interrupt during `cops install` itself: M1's own rollback (D-091) |
| 9 | Service fails to start | setup stops before installing hooks, prints `status` and the log tail, exits 1; doctor `fail` on the service and the socket | Without a service the user must start `copsd` by hand; printed |
| 10 | Service starts a stale binary after an upgrade | unit exec is an absolute path that the package/installer updates in place; `cops doctor` compares `/v1/health` version with the CLI's; `cops service restart` | — |
| 11 | `install.sh` tampered or a wrong archive | TLS, `SHA256SUMS` verified before extraction, optional attestation; sums come from the release job, not from the same tarball | The sums file and the archive come from the same origin: attestation is what binds them to the source; opt-in until the repo can attest |
| 12 | The agent runs `cops setup`, `cops service`, `cops scan --accept` | `config-tamper` holds those CLIs (judge-guard list, with D-114) | `cops scan` without `--accept` is allowed: it reads nothing private |
| 13 | LLM mode set by a repo `.cops.toml` | `[scanner] mode` is not repo-overridable (tighten-only rule; `mode` is not a tightening); only `unsafe` may be raised | — |
| 14 | `none` adapter read as "safe" | `none` yields `status: none` → `annotate`, never `safe` | — |

## 9. Security notes

- **Supply chain of the installer**: sums always, attestation when available, no sudo, no `eval`,
  no self-update; the script is in the repo and attached to the release; the release job is
  manual (`workflow_dispatch`) with `contents: write` only in that workflow.
- **No silent third-party installs**: the only third-party commands `cops setup` can run are the
  two documented SkillSpector installs and `bun add -g jev-cops`, each printed verbatim and confirmed
  on its own, never under a bare `--yes`.
- **Scanner runs on the host, as the daemon's user, in exec form, with a scrubbed env, in a private
  temp dir, bounded in time and output**; static mode by default; LLM mode is an explicit config
  key and the wizard states what leaves the machine (contents to the provider; names to OSV.dev
  either way). The MCP mode of SkillSpector is not used (§2 row 4).
- **The scanner never fetches**: remote sources are fetched by the daemon with the hardened git
  runner and no credentials (§4.1), or not at all.
- **Keys**: never written by setup (D-044); the audit signing key is created by `cops keygen`
  (M2 step 5) and never leaves `~/.jev-cops/keys/`.
- **Scores off agent channels** (D-066, D-096) extend to the scanner's score; the recommendation
  word and titles are the human's evidence.
- **Cache override is human-only** (`--accept` through the admin socket or the local store) and
  never applies to `unsafe`.

## 10. Test list

Runner `bun test`; sibling `*.test.ts`; nothing below touches the real home, PATH tools or the
network; the fake `skillspector` is compiled once per test run into the temp dir.

**scanner** — `createScanner` for each config (missing binary → `available()` false and `scan()` error,
never throws) · fake skillspector fixtures: `safe.json`, `caution.json`, `do-not-install.json`
(exit 1), `error-exit-2`, `garbage-stdout`, `huge-stdout` (5 MiB), `hang` (sleeps past the
deadline; process group killed), `llm-requested-unavailable` → error, `missing-recommendation` →
error · argv byte-exact (`--no-llm` present by default, absent in llm mode; docker form; env scrub;
`SKILLSPECTOR_MAX_WORKFLOW_SECONDS`) · `command` adapter: contract JSON accepted, unknown fields
ignored, missing `verdict` → error · materialize: Write/Edit/NotebookEdit shapes, sibling copy
limits, symlink not followed, content hash stable across ordering · remote: https git fetched
through the hardened runner (fake git records argv and env), `ssh://` refused, size cap · parse:
titles bounded, prompt-like flagged · gated live: `JEV_COPS_SCANNER_LIVE=1` and `skillspector` on
PATH runs the real tool on the two bundled fixture skills and asserts the recommendation words.

**core + sdk** — `skillInstallTargets` per surface of §5 (each root, project and home anchors, the
CLI verbs, `git clone` into a root, negatives) · `install-verbs` rows in `commands.json` · `ctx.scan`
defaults to `noScan()`; a fixture `scan` field reaches the policy · fixtures of §5 alone and with the
set; `bun run gate` byte-identical for the six existing files.

**daemon** — inline done → `judge` line carries `scan` · pending → hold + detached completion writes
a `scan` line and fills the cache · cached retry → no process spawned · error → hold + anomaly ·
`max_concurrent` → busy error · `--accept` row turns caution into safe for that hash only, never
unsafe · post-install scan on `config-change: skills` → anomaly + `context_note` on the next verdict
· `/v1/health.scanner` · observe mode mapping · `[scanner]` validation: unknown adapter, `mode` in a
repo override dropped and reported, `unsafe` raise-only.

**cli** — `cops scan` exit codes and `--json` schema; `--accept` with and without a daemon · doctor
`scanner` group on configured/missing/stale/self-test-failing scanners; `--scan-installed` report ·
`cops service`: golden plist/unit per platform and both install paths (compiled, npm), argv on the
fake `launchctl`/`systemctl`, status digest, uninstall leaves nothing, `--dry-run` writes nothing ·
`cops setup`: scripted stdin through every branch of §6 (defaults, each alternative, invalid input
re-asked, Ctrl-D = abort), `--yes` matrix, flags vs answers precedence, journal + re-run deltas,
interrupt after each step (the fake runner throws) then convergence, `--uninstall` keeps audit and
keys, `--dry-run` under the refusing fs, third-party command shown before the yes and never run under
bare `--yes`, `bunx` re-exec path, hook build on the npm path (fake `bun build` runner), the two-minute
budget asserted on the fake path (< 10 s).

**install.sh** — Bun.serve fake release server with the four archives and `SHA256SUMS`: happy path
into a temp prefix, corrupted sum refused before extraction, missing sum tool refused, unsupported
`uname -m` refused, `--prefix`, `--version`, PATH hint, quarantine strip on macOS (xattr set by the
test), `--no-setup`. Runs on both CI OSes.

**e2e (gate)** — the §1 gate on a throwaway `HOME` with the fake `claude` runner of M1, the fake
`skillspector` and the compiled `cops-hook`.

**live (never in CI)** — `docs/captures/setup.md`: real `bunx jev-cops setup` from a local `bun pm
pack` registry (verdaccio or `bun add -g ./jev-cops.tgz`), real `uv tool install`, real
`skillspector`, timing, then `Write ~/.claude/skills/evil/SKILL.md` from a real `claude` against the
local fake API as in the M1 capture.

## 11. Proposed DECISIONS rows (unnumbered; the lead assigns numbers in landing order)

- **S-1** Spec extension (owner): `cops setup`, `cops service`, `cops scan`, a pluggable scanner
  behind `[scanner]` and the `skill-install` starter policy; the npm meta package `jev-cops` is the
  primary install, compiled binaries + `install.sh` the no-Bun path.
- **S-2** `Scanner` interface and `createScanner` mirror D-004: `none | skillspector | command`;
  never throws at startup; a missing tool answers `error`; static mode default; `mode = "llm"` is an
  explicit, non-repo-overridable key; adapters read the tool's recommendation, never re-derive it.
- **S-3** On the npm path the Claude Code hook is still a compiled binary, built by `cops setup`/
  `cops install` with `bun build --compile` into `~/.local/libexec/jev-cops/` and version-checked
  (D-091); a shim that needs `bun` on PATH would fail open.
- **S-4** The daemon protects its own package root on the npm path as it protects the compiled
  binary (D-082).
- **S-5** Two-phase scanning: inline within `[scanner] inline_ms` (6 000) else `hold` "scan pending",
  detached completion bounded by `deadline_ms` (60 000, also `SKILLSPECTOR_MAX_WORKFLOW_SECONDS`),
  `max_concurrent` 2, result cached by content hash for `cache_ttl_ms` (7 days); a human `--accept`
  lowers `caution` to `safe` for one hash, never `unsafe`.
- **S-6** Static mode is documented as "contents stay local; dependency names and versions go to
  OSV.dev" (SkillSpector SC4); the result records `network`.
- **S-7** `skill-install` maps unsafe → `deny` (`[scanner] unsafe = "kill"` raise-only), caution →
  hold, safe → annotate, none → annotate, pending/error → hold; the confirm summary carries the
  recommendation word and ≤ 5 finding titles, never the score (D-096); a scanner never lowers
  another policy's verdict.
- **S-8** The scanner never fetches: remote sources are cloned/downloaded by the daemon with the
  D-067 hardened runner over https only, pinned to a commit; otherwise `error` (hold).
- **S-9** `cops setup` writes nothing before one confirmed plan, journals what it creates, is
  idempotent, and runs a third-party install only after its own yes (never under bare `--yes`);
  hooks are installed only after the daemon answers `/v1/health`; `--uninstall` keeps the audit
  log, store and keys.
- **S-10** Releases: CI-built `SHA256SUMS` + GitHub artifact attestations (Sigstore keyless), not
  the D-104 key (a per-deployment audit key) and not a rebuild gate (Bun builds are not
  byte-reproducible); macOS binaries are Developer-ID-signed and notarized only when the secrets
  exist, else ad hoc; `install.sh` verifies sums always and provenance on request.
- **S-11** Service units use absolute paths and an explicit `PATH`; launchd `bootstrap gui/$UID`
  (never `load`), `KeepAlive.SuccessfulExit = false`, `ExitTimeOut 10`; systemd `--user`,
  `Restart=on-failure`; linger is offered, not forced; logs in `~/.jev-cops/copsd.log`.
- **S-12** Post-install scans (config-change `skills`, install CLIs, `--scan-installed`) report:
  anomaly line, next-verdict `context_note`, doctor `fail`; they never gate.

## 12. Open questions for the owner

1. **Publishing.** Nothing here runs until the repo (or a release fork) is public: GitHub
   attestations and npm provenance are for public artifacts, `bunx jev-cops` needs the packages on
   npm (`@jev-cops` org, `npm login`, 2FA), and the release job is a manual dispatch. When?
2. **Apple signing.** Notarized macOS binaries need an Apple Developer Program membership and a
   Developer ID certificate in the repo's secrets; without it browser downloads are blocked by
   Gatekeeper (curl/`install.sh` downloads are not). Buy it, or document `xattr -d` for v1?
3. **Scanner default.** The wizard defaults to `none` and recommends SkillSpector when `uv`/`docker`
   is present. Should a detected `skillspector` on PATH flip the default to `skillspector`?
   (The plan says yes: a tool already installed costs nothing to use; say no to keep `none`.)

Everything else is a proposed row in §11, chosen as the safer option.

## 13. Lead amendments (2026-09-30)

1. **§12 question 3 answered (delegated to the lead):** a `skillspector` already on `PATH`
   flips the wizard's scanner default from `none` to `skillspector`; the wizard still says
   which dependency data leaves the machine (OSV.dev) and asks before enabling.
2. **§12 questions 1–2 stay with the owner** and block only the public release, not the
   build: when the repo and packages go public (attestations, npm provenance and `bunx`
   need it), and whether to buy an Apple Developer ID for notarized macOS binaries (v1
   documents `xattr -d` otherwise).
3. **Release workflow ownership.** The npm-packaging agent is writing
   `.github/workflows/release.yml` and `RELEASING.md` now; S6 extends that workflow with the
   compiled-binary job after it lands instead of creating a second one.
4. **Order.** S0 (`packages/scanner`) and S4 (`cops service`) start now; S1 after the
   config-tamper fix lands; S2–S3 after M2 steps 3, 5 and 7; S5 after S2–S4; S6 after the
   npm work; S-rows are numbered D-### as they land.
