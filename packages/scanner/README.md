# @jev-cops/scanner

Security scanners for the skills, plugins and MCP servers a coding agent installs, behind
one `Scanner` interface. The daemon (`copsd`) scans what an agent is about to install and
the `skill-install` policy turns the answer into a verdict: `unsafe` is denied, `caution`
is held for a human, `safe` is annotated. A scanner never allows anything on its own, and
any failure is `verdict: "error"`, which holds.

```ts
import { createScanner } from "@jev-cops/scanner";

const scanner = createScanner({ adapter: "skillspector" }); // static mode: --no-llm
const result = await scanner.scan({ kind: "dir", path: "/abs/skill" }, { deadlineMs: 60_000 });
// { verdict: "caution", score: 35, findings: [...], tool: "skillspector", network: "osv-only", ... }
```

## Adapters

| `adapter` | What runs | Pick it when |
|---|---|---|
| `none` | Nothing | You have no scanner yet. The daemon reports `status: "none"` and the policy annotates ("no scanner configured"); `none` is never read as `safe` |
| `skillspector` | [NVIDIA SkillSpector](https://github.com/NVIDIA/skillspector)'s CLI, static by default | The recommended scanner |
| `command` | Any program that prints the [`jev-cops.scan/1`](#the-command-contract) document | You use another scanner (Snyk Agent Scan, Cisco Skill Scanner, your own) through a small wrapper |

`createScanner` mirrors `@jev-cops/judge`'s `createJudge`: it never throws. A missing tool
yields a scanner whose `available()` says why and whose `scan()` answers
`{ verdict: "error", error: "skillspector not found on PATH" }`. The tool is looked up at
each call on the absolute entries of the daemon's `PATH`, so installing it later needs no
restart.

## What a result holds

```ts
interface ScanResult {
  verdict: "safe" | "caution" | "unsafe" | "error";
  score: number | null;           // 0..100 as the tool reports it; kept out of agent-visible text
  findings: ScanFinding[];        // at most 64, most severe first; titles are one line, ≤ 200 chars
  truncated: number;              // findings beyond the 64
  tool: string; version: string | null; mode: "static" | "llm";
  durationMs: number;
  error: string | null;           // verdict "error" only: one line
  network: "none" | "osv-only" | "provider";  // what left the machine, as far as the adapter knows
  promptLike: string[];           // D-050 prompt-like patterns found in titles or the error line
  stderrTail: string | null;      // verdict "error" after the tool ran: last 2 KB of stderr
}
```

## SkillSpector

jev-cops drives the CLI, which SkillSpector documents as its stable contract:

```text
skillspector scan <dir> --format json --no-llm
```

- **Verdict**: exit 0 or 1 with the JSON report is a verdict, read from
  `risk_assessment.recommendation` (`SAFE` → `safe`, `CAUTION` → `caution`,
  `DO_NOT_INSTALL` → `unsafe`), never re-derived from the score or the exit code. Exit 2,
  any other exit, output that is not the documented JSON, or a report missing a required
  field is `error`.
- **Static mode (default)**: `--no-llm`; file contents stay on the machine. SkillSpector's
  supply-chain check (SC4) still sends the dependency names and versions a skill declares to
  OSV.dev, so a static result says `network: "osv-only"`.
- **LLM mode** (`mode: "llm"`, never repo-overridable): the documented `SKILLSPECTOR_*` and
  provider key variables are passed from the daemon's environment (never from config,
  D-044). A report where the LLM pass was requested but did not run is an `error`, not a
  clean static scan; an LLM pass in static mode is an `error` too.
- **Bounds**: one process per scan, exec form, a scrubbed environment (`PATH`, `HOME`,
  `LANG`, `TMPDIR`), `SKILLSPECTOR_MAX_WORKFLOW_SECONDS` = the deadline in seconds,
  `SKILLSPECTOR_LOG_LEVEL=ERROR`, stdout capped at 4 MiB. The child gets its own process
  group, killed at the deadline.
- **`extraArgs`**: only `--fail-on-findings`, `--fail-on-incomplete`, `--recursive`,
  `--transitive`, `--yara-rules-dir <abs>` and `--baseline`/`-b <abs>`. Anything else
  (notably `--use-shipped-baseline`, which lets a skill author's baseline suppress
  findings) makes every scan an `error`.
- **Docker**: `docker: { image: "skillspector" }` runs
  `docker run --rm --cap-drop ALL --security-opt no-new-privileges -v <dir>:/scan:ro … <image> scan /scan --format json --no-llm`,
  passing variables by name (`-e NAME`), never their values. `network: "none"` adds
  `--network none` for air-gapped hosts; OSV lookups then fall back to SkillSpector's bundled list.
- The MCP mode is not used: it defaults to LLM analysis, has a known stdio hang and no
  exit codes.

Install SkillSpector with one of its two documented commands (it is not on PyPI):

```bash
uv tool install git+https://github.com/NVIDIA/skillspector.git
# or: git clone https://github.com/NVIDIA/skillspector && docker build -t skillspector skillspector
```

## The command contract

`{ adapter: "command", argv: ["/abs/path/wrapper", "--flag"] }` runs `argv` plus the
directory to scan as the last argument:

```text
/abs/path/wrapper --flag /home/me/.jev-cops/scan/<sha256>.<random>
```

- `argv[0]` is an absolute path, or a bare name looked up on the absolute entries of the
  daemon's `PATH`. No shell is involved.
- It runs in that directory, with only `PATH`, `HOME`, `LANG` and `TMPDIR` in its
  environment. It never receives the daemon's API keys; a wrapper that needs one reads its
  own configuration.
- It must print one JSON document on stdout, at most 4 MiB, before the deadline (the whole
  process group is killed then). **The exit code is ignored**: only the document decides.
- `network` in the config says what the command sends off the machine: `none`, `osv-only`
  or `provider` (the default, since jev-cops cannot know). The document may widen it, never
  narrow it.

The document, schema `jev-cops.scan/1` (unknown fields are ignored):

```json
{
  "schema": "jev-cops.scan/1",
  "verdict": "caution",
  "score": 35,
  "tool": "my-scanner",
  "version": "1.2.0",
  "network": "none",
  "findings": [
    { "id": "E1", "severity": "medium", "title": "Sends data to an external URL", "file": "scripts/sync.py", "line": 45 }
  ]
}
```

| Field | Required | Values |
|---|---|---|
| `schema` | yes | `"jev-cops.scan/1"` |
| `verdict` | yes | `safe`, `caution`, `unsafe`, or `error` (then put the reason in `error`) |
| `score` | no | 0..100 or null; shown to humans only, never to the agent |
| `findings` | no | each `id`, `severity` (`low` `medium` `high` `critical`), `title`; `file`, `line` (≥ 1) optional |
| `tool`, `version` | no | strings; `tool` defaults to the program's file name |
| `error` | no | a string, used when `verdict` is `error` |
| `network` | no | `none`, `osv-only`, `provider` |

Anything else (not JSON, a missing `verdict`, an unknown severity) is
`error: "unreadable scanner output"`.

## Materializing what the agent is about to write

A scanner reads a directory, but a `Write` or `Edit` has not happened yet. `materialize`
builds the directory the scanner sees:

```ts
const m = await materialize(skillDir, { kind: "write", file, content }, "~/.jev-cops/scan");
// m.value.dir: <root>/<sha256>.<random>/ (0700), m.value.sha256, m.value.cleanup()
```

- The skill directory's current files are copied with the change applied (`write`,
  `edit` with literal `old → new`, `notebook-edit`, or `copy` for a local source).
- Symlinks inside are refused and never read; `.git` is skipped; more than 100 files, a
  file over 1 MiB or a tree deeper than 16 levels is refused, never scanned in part.
- `collectSkill` reads and hashes in memory first, so the daemon can look its cache up
  before writing anything. The hash is SHA-256 over the sorted `relative path\0bytes\0`
  sequence.

Remote sources are fetched by the daemon, never by a scanner: `fetchGitSource` clones an
https git URL with git's config hooks, credential helpers, prompts, redirects, submodules
and every transport but https turned off, `--depth 1`, 20 s, 100 MiB, pinned to its commit.
`ssh://`, `git@…`, credentials in the URL, private hosts and zip downloads are refused.

## Tests

`bun test packages/scanner` runs the contract suite (11 checks over `none`, `skillspector`
and `command`) against a fake `skillspector` that the tests compile once with
`bun build --compile`. Nothing touches the network or the real home directory. The real
tool runs only on request:

```bash
JEV_COPS_SCANNER_LIVE=1 bun test packages/scanner/src/live.test.ts   # needs skillspector on PATH
```
