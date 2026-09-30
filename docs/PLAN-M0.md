# M0 plan — core + Pi adapter

Source of truth: [SPEC.md](./SPEC.md). M0 definition of done (spec §Milestones):
canonical schema, normalizer with tree-sitter-bash, context engine with all five
features, SDK with `definePolicy`, three starter policies with fixtures, Pi adapter
blocking and rewriting end to end. Gate: `cops test` green.

This session delivers the first three rows of the table below and stops.

## Build order

| # | Package / module | Delivers | Gate |
|---|---|---|---|
| 1 | `packages/core/src/schema` | Event + verdict schemas, validation, verdict ladder | schema tests |
| 2 | `packages/core/src/normalizer` | tree-sitter-bash AST → `NormalizedEvent` | normalizer tests, T5 + T9 assertions |
| 3 | `packages/core/src/context` | case file, five features, risk budget | context tests, T10 + T11 assertions |
| — | *(session boundary: stop and report)* | | |
| 4 | `packages/core/src/judge` | provider-agnostic `Judge` interface, mock provider, cache | judge tests, T6 assertion |
| 5 | `packages/core/src/policy` | floor risk, policy loader, monotonic combination | combine tests (monotonic floor −0.2 max) |
| 6 | `packages/sdk` | `definePolicy`, `jev.noul/choice/score`, fixture runner | fixture runner tests |
| 7 | `policies/` | `tainted-destructive`, `default-branch-guard`, `off-repo-write` + fixtures | `cops test` |
| 8 | `packages/daemon` | Unix socket + localhost HTTP, `POST /v1/judge`, `POST /v1/observe`, SQLite stores, JSONL audit chain | daemon tests, T2/T3 assertions |
| 9 | `packages/cli` | `cops test`, `cops explain` (rest of the CLI is M1+) | `cops test` green on the repo |
| 10 | `adapters/pi` | `tool_call` / `tool_result` / `before_agent_start` extension, < 150 lines, zero policy | captured run: block + rewrite end to end |

Judge providers beyond `mock` (`jev`, `openrouter`, `vercel-ai`) land in step 4 behind
the `judge.provider` config key; each has a contract test run against the mock
transport. Live calls are never made in tests.

## Module map (`packages/core`)

```text
src/
  schema/
    event.ts        zod schemas: Event (pre|post), Session, Actor, Call, Env, Result; parseEvent()
    verdict.ts      VERDICTS ladder, compare/max/raise, Verdict schema; parseVerdict()
    ids.ts          ULID + prefix validation (evt_, sess_, call_)
  normalizer/
    parser.ts       web-tree-sitter singleton, loads tree-sitter-bash.wasm once
    bash.ts         AST walk → commands, words, pipes, redirects, heredocs, opaque flags
    decode.ts       literal base64 / hex decoding of argument words (bounded depth)
    paths.ts        ~ and $HOME expansion, relative → absolute against cwd, no FS access
    classify.ts     argv → CallKind + verbs (read/delete/net/exec/interpreter) + targets
    normalize.ts    Event → NormalizedEvent (exec, fs.*, net, spawn, other)
  context/
    casefile.ts     CaseFile interface + SQLite impl (bun:sqlite), in-memory for tests
    secrets.ts      secret path globs + content patterns (spec §Session case file)
    taint.ts        taint set registration from post events; taint fraction for pre events
    scope.ts        deterministic scope: path in repo, host in allowlist, tool in expected set
    sequence.ts     windowed pattern matches over the case file (4 spec patterns)
    environment.ts  weighted exposure sum
    reversibility.ts reversible vs irreversible classification
    budget.ts       100-point budget, 10/min decay, round(risk*20) cost, 80%/100% thresholds
    features.ts     computeFeatures(normalized, casefile) → Features (all five, deterministic)
  judge/            (step 4) Judge interface, providers/{mock,jev,openrouter,vercel-ai}, cache
  policy/           (step 5) floor.ts, loader.ts, combine.ts, engine.ts
```

## Interfaces

```ts
// schema/event.ts — mirrors spec §Canonical event schema exactly
type Phase = "pre" | "post";
type Harness = "claude-code" | "codex" | "opencode" | "pi";
type CallKind = "exec" | "fs.read" | "fs.write" | "fs.delete" | "net" | "spawn" | "other";
interface Event {
  schema: "jev-cops.event/1";
  id: string;                       // evt_<ULID>, required
  phase: Phase;                     // required
  harness: Harness; harness_version?: string;
  session: { id: string; parent_id: string | null; task?: string; mode?: "interactive" | "headless"; started_at?: string };
  actor: { kind: "agent" | "subagent" | "user"; model?: string };
  call: { id: string; tool: string; kind: CallKind; input: Record<string, unknown>; cwd: string };
  env?: { git?: {...}; sandbox?: { kind: "openshell" | "none"; name?: string } };
  result?: { ok: boolean; exit_code?: number; stdout_sha256?: string; stdout_head?: string; bytes_out?: number }; // post only
}
function parseEvent(input: unknown): Result<Event, SchemaError>;   // never throws

// schema/verdict.ts
const VERDICTS = ["allow", "annotate", "rewrite", "hold", "deny", "kill"] as const;
type Verdict = typeof VERDICTS[number];
function maxVerdict(a: Verdict, b: Verdict): Verdict;
function raiseVerdict(v: Verdict, steps: number): Verdict;         // saturates at "kill"
function isDenyClass(v: Verdict): boolean;                         // deny | kill

// normalizer/normalize.ts
interface NormalizedCommand {
  argv: string[];                   // decoded, expanded words of one simple command
  kind: CallKind;                   // per-command classification
  targets: { paths: string[]; hosts: string[] };
  verbs: string[];                  // e.g. ["rm","recursive","force"], ["git","push","force"]
  isInterpreter: boolean;           // sh -c, python -c, node -e, eval, …
}
interface NormalizedEvent {
  event: Event;
  kind: CallKind;                   // max-severity kind across commands
  commands: NormalizedCommand[];    // flattened over pipes, lists, subshells
  paths: string[]; hosts: string[]; // union, absolute, expanded
  opaque: { reason: OpaqueReason; span: string }[];  // $(…), eval, heredoc, interpreter, decoded pipe
  decodedLiterals: { encoding: "base64" | "hex"; raw: string; decoded: string }[];
  stateHash: string;                // sha256 of the normalized shape, keys the Jev cache
  raw: string;                      // raw command or JSON input, for the human-facing confirm (T8)
}
function normalize(event: Event, opts: { home: string }): Promise<NormalizedEvent>;

// context/features.ts
interface Features { taint: number; scope: number; sequence: number; environment: number; reversibility: number }
interface FeatureExplanation { [feature: string]: string[] }     // human-readable evidence per feature
function computeFeatures(n: NormalizedEvent, cf: CaseFile, cfg: ContextConfig): { features: Features; why: FeatureExplanation };

// context/casefile.ts
interface CaseFile {
  sessionId: string; parentId: string | null; task: string | null;   // task immutable once set (T11)
  setTaskOnce(task: string): void;
  recordPre(n: NormalizedEvent): void;
  recordPost(n: NormalizedEvent): void;              // registers taint, secret reads, failures, file hashes
  taintSet(): ReadonlyArray<{ value: string; sourceCallId: string; at: number }>;
  secretReadsSince(ms: number): SecretRead[];
  hostsSeen(): ReadonlyMap<string, number>;
  filesWritten(): ReadonlyMap<string, { sha256: string; taint: number }>;
  failuresInARow(): number;
  budget: RiskBudget;
  recentCalls(windowMs: number): CallRecord[];
}
```

## Deterministic floor (proposal, decided in step 5)

The spec does not give the formula that maps the five features to the floor risk.
Proposal, recorded in DECISIONS.md once implemented:

```text
floor = clamp01( 0.35·taint + 0.25·(1−scope) + 0.20·sequence + 0.10·environment + 0.10·reversibility )
bands: < 0.3 allow · 0.3–0.5 annotate · 0.5–0.8 hold · > 0.8 deny   (spec §Verdict ladder)
```

Policies raise from there; nothing lowers below `floor − 0.2`.

## Test list

Runner: `bun test`. Every module has a sibling `*.test.ts`. Fixtures under
`tests/fixtures/events/` are canonical JSON events reused across packages.

**schema** — accepts valid pre event · accepts valid post event · rejects missing
`id`/`phase`/`session.id`/`call.*` with the field path in the error · rejects unknown
`schema` version · rejects malformed ULID · rejects `result` on a pre event · accepts
unknown `call.tool` strings · `kind` outside the enum is rejected · verdict ladder:
`maxVerdict` is commutative and idempotent · `raiseVerdict` saturates at `kill` ·
`parseVerdict` round-trips the spec example.

**normalizer** — simple command argv · pipeline flattens to N commands · `&&`/`;`
lists · subshell · `$(…)` flagged opaque (T9) · `eval` opaque · `sh -c`, `bash -c`,
`python -c`, `node -e` interpreter + opaque (T5) · heredoc to file flagged (T5) ·
`echo <b64> | base64 -d | sh` decoded and opaque (T5) · hex literal decoded · `~` and
`$HOME` expanded · relative path resolved against `cwd` · `..` normalized · `cat`,
`head`, `tail`, `sed -n`, `less` → `fs.read` (Codex rule) · `rm`/`rm -rf`/`unlink`/
`shred` → `fs.delete` · `curl`/`wget`/`ssh`/`scp`/`nc` → `net` with host extracted ·
`git push --force` verbs · `git reset --hard` verbs · `Edit`/`Write` tool → `fs.write`
with path · `Read` → `fs.read` · `WebFetch` → `net` with host · `Task` → `spawn` ·
unknown tool → `other` · `stateHash` is stable across whitespace and quoting ·
`raw` preserves the original text · malformed bash still returns (parse errors
→ opaque, never throws).

**context** — taint: fraction of arg tokens found in taint set · user-typed text never
tainted · post event registers URLs, hosts, paths, commands from `stdout_head` ·
read of a self-written tainted file inherits taint (T10) · scope: path inside repo →
1, outside → 0, host in task allowlist → 1 · task-derived allowlist from task text +
git remote · sequence: secret-read→net within window · repeated failures→sudo ·
write executable→exec it · new host after secret read · window boundary respected ·
environment: default branch, cwd outside repo, dirty tree, headless each add weight;
sum ≤ 1 · reversibility: tracked write under git → 0; `git push --force`, `reset --hard`,
delete outside git, net POST/PUT/DELETE → 1 · secrets: each spec glob detected;
content pattern in `stdout_head` marks the read as secret · case file: SQLite
round-trip · subagent session shares parent case file by reference · task set once,
second set is ignored and logged (T11) · budget: cost = round(risk·20) · decays 10/min ·
80% → raise one step flag · 100% → hold flag · reset.

**tamper (tests/tamper/T01…T13.test.ts)** — one file per threat, assertion written
from the spec's "required outcome"; `test.todo` until its milestone, then live.
T5, T6, T9, T10, T11 have their core-level assertions live in this session.

## Open decisions (from spec §Open decisions)

1. **Headless `hold`** — **decided 2026-09-29: `deny` with the reason.** Applies to
   headless sessions on every harness and to Pi, whose `tool_call` can only allow or block.
2. **Thresholds/budget** — **decided 2026-09-29: spec defaults** (100 points, 10/min decay,
   0.3 / 0.5 / 0.8 bands) as the `cops.toml` defaults for the pilot.
3. **Name** — `jev-cops` and `@jev-cops/*` are free on npm (checked 2026-09-29). PyPI and
   the `.dev` domain still to check; owner will decide.

Answered by your ground rules: Jev behind a feature flag and mocked in tests (data path);
provider pluggable (jev / openrouter / vercel-ai) per your later note — see DECISIONS.md D-004.
