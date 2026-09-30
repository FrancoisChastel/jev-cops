import type { ContextConfig, SequencePatternName } from "../context/config.ts";
import type { FeatureResult, Features } from "../context/features.ts";
import type { RepoHints, TaskAllowlist } from "../context/scope.ts";
import type { CallRecord, CaseFile, FileWrite, SecretRead } from "../context/types.ts";
import type { AnswerFor, Judge, Question } from "../judge/types.ts";
import type { NetMethod, NormalizedEvent, OpaqueSpan, PathAccess } from "../normalizer/types.ts";
import type {
  ActorKind,
  CallKind,
  GitInfo,
  Harness,
  Phase,
  PostEvent,
  PreEvent,
  SandboxKind,
  SessionMode,
} from "../schema/event.ts";
import type { Verdict } from "../schema/verdict.ts";
import type { PolicyConfig } from "./config.ts";
import type { Decision } from "./decision.ts";

/**
 * Typed answers for a question list: each asked name maps to the answer type of its
 * question kind (noul → `{ p, confidence }`, choice → `{ choice, p, … }`, score →
 * `{ level, score, … }`), keeping literal names, options and rubric labels.
 */
export type AnswersFor<Q extends readonly Question[]> = {
  readonly [K in Q[number] as K["name"]]: AnswerFor<K>;
};

/** A window: milliseconds, or `Ns`, `Nm`, `Nh`. */
export type DurationInput = number | `${number}s` | `${number}m` | `${number}h`;

/** The session as policies see it; `task` is the case file's immutable task (T11). */
export interface PolicySession {
  readonly id: string;
  readonly task: string | null;
  readonly mode: SessionMode | null;
  readonly parentId: string | null;
}

/** The tool call. `kind` is the daemon's classification; `adapterKind` the adapter's guess. */
export interface PolicyCall {
  readonly id: string;
  readonly tool: string;
  readonly kind: CallKind;
  readonly adapterKind: CallKind;
  readonly cwd: string;
  /** A frozen deep copy of the raw tool input. */
  readonly input: Readonly<Record<string, unknown>>;
}

/** One simple command after normalization. */
export interface PolicyCommand {
  readonly argv: readonly string[];
  readonly kind: CallKind;
  readonly verbs: readonly string[];
  readonly paths: readonly string[];
  readonly hosts: readonly string[];
  readonly isInterpreter: boolean;
  readonly viaInterpreter: boolean;
  /** Runs on another host (ssh's remote command); its paths resolve as if local. */
  readonly remote: boolean;
  readonly method: NetMethod | null;
  readonly raw: string;
}

/** Read-only view of a normalized event: what `when`, `ask` and `decide` receive. */
export interface PolicyEvent {
  readonly id: string;
  readonly phase: Phase;
  readonly harness: Harness;
  readonly session: PolicySession;
  readonly actor: { readonly kind: ActorKind; readonly model: string | null };
  readonly call: PolicyCall;
  /** Same as `call.kind`: the daemon's event-level kind (D-013). */
  readonly kind: CallKind;
  readonly commands: readonly PolicyCommand[];
  /** Union of every command's verbs. */
  readonly verbs: readonly string[];
  readonly paths: readonly string[];
  readonly hosts: readonly string[];
  readonly opaque: readonly Readonly<OpaqueSpan>[];
  /** The verbatim command or tool input JSON (T8). */
  readonly raw: string;
  /** First host (null when none), all hosts, and the most severe HTTP method seen. */
  readonly net: {
    readonly host: string | null;
    readonly hosts: readonly string[];
    readonly method: NetMethod | null;
  };
  /** Paths and, per path, its most severe access (delete > write > exec > unknown > read). */
  readonly fs: {
    readonly paths: readonly string[];
    readonly access: Readonly<Record<string, PathAccess>>;
  };
  readonly env: {
    readonly git: Readonly<GitInfo> | null;
    /** Missing sandbox info counts as `none` (D-024). */
    readonly sandbox: { readonly kind: SandboxKind; readonly name: string | null };
  };
}

/** Windowed sequence helpers over the case file. */
export interface SequenceView {
  /** A secret read within `window`, counting the judged call's own read (D-022). */
  secretReadWithin(window: DurationInput): boolean;
  /** True when spec pattern `name` matched for this event (default windows). */
  matched(name: SequencePatternName): boolean;
  readonly score: number;
}

/** Deterministic scope helpers. */
export interface ScopeView {
  /** In the task allowlist (task hosts, git remote, lockfile registries); null → false. */
  hostAllowed(host: string | null | undefined): boolean;
  /** Under the repo root (or cwd without one); relative paths resolve against cwd. */
  pathInRepo(path: string): boolean;
  readonly score: number;
  /** True when only soft scope rules fired. */
  readonly unsure: boolean;
  readonly allowlist: Readonly<TaskAllowlist>;
}

/** Taint helpers: one token's level, and the event's fraction. */
export interface TaintView {
  of(token: string): number;
  readonly fraction: number;
}

/** The read-only subset of the case file a policy may query. */
export interface CaseFileView {
  readonly sessionId: string;
  recentCalls(within: DurationInput): readonly CallRecord[];
  secretReadsWithin(within: DurationInput): readonly SecretRead[];
  hostsSeen(): ReadonlyMap<string, number>;
  filesWritten(): ReadonlyMap<string, FileWrite>;
  failuresInARow(): number;
}

/** The session budget before this event is charged. */
export interface BudgetView {
  readonly spent: number;
  readonly limit: number;
  readonly ratio: number;
  readonly raiseSteps: 0 | 1;
  readonly holdAll: boolean;
}

/** Environment helpers, so policies never duplicate the default-branch rule. */
export interface EnvView {
  /** `main`, `master` (config) and the reported `default_branch` (D-068). */
  readonly defaultBranches: readonly string[];
  /** The current branch is one of {@link defaultBranches}; false when it is unknown. */
  readonly onDefaultBranch: boolean;
}

/** Daemon configuration a policy may read. */
export interface PolicyConfigView {
  /** What `~`/`$HOME` expand to: daemon config, never the event (D-003). */
  readonly home: string;
  /**
   * `[policy] protectedPaths`: absolute after `~`/`$HOME` expansion, or project-relative
   * as written; trailing slashes dropped. Empty by default.
   */
  readonly protectedPaths: readonly string[];
  /**
   * `[policy] privatePaths` plus the daemon's own records: absolute after `~`/`$HOME`
   * expansion, trailing slashes dropped; an entry starting with `!` exempts that path. A
   * path is private when the longest entry it is equal to or under is not an exemption.
   * Empty by default.
   */
  readonly privatePaths: readonly string[];
}

/** The helper API a policy receives as `ctx` (spec §Policy-as-code example). Frozen. */
export interface PolicyContext {
  readonly session: PolicySession;
  readonly features: Readonly<Features>;
  /** Deterministic floor risk for this event. */
  readonly floor: number;
  readonly sequence: SequenceView;
  readonly scope: ScopeView;
  readonly taint: TaintView;
  readonly casefile: CaseFileView;
  readonly budget: BudgetView;
  readonly env: EnvView;
  readonly config: PolicyConfigView;
}

/** A policy callback that receives answers; bivariant so specific policies share a list. */
export type PolicyFn<Q extends readonly Question[], R> = {
  bivarianceHack(e: PolicyEvent, ctx: PolicyContext, a: AnswersFor<Q>): R;
}["bivarianceHack"];

/**
 * A policy module's default export (spec §Policy-as-code DSL). `when` is pure, sync and
 * budgeted at 2 ms; `ask` returns at most 4 questions; `decide` owns the verdict and the
 * engine applies the monotonic rules on top, so no policy can lower another's verdict.
 * The engine clamps every contribution into `range` (declared, ascending); `fallback`
 * replaces `decide` when the policy's questions got no usable answer ("the floor stands"
 * by default).
 */
export interface PolicyDefinition<Q extends readonly Question[] = readonly Question[]> {
  readonly name: string;
  readonly version: number;
  readonly owner: string;
  when(e: PolicyEvent, ctx: PolicyContext): boolean;
  ask?(e: PolicyEvent, ctx: PolicyContext): Q;
  decide(e: PolicyEvent, ctx: PolicyContext, a: AnswersFor<Q>): Verdict;
  /** One sentence, safe to show the agent. */
  readonly reason: string | PolicyFn<Q, string>;
  /**
   * For the human only; never reaches the harness. Plain language, no score: on a hold it
   * is the confirm prompt's own line, which can land where the agent reads it (Claude
   * Code's session transcript); features, taint and risk are in the engine's detail.
   */
  detail?(e: PolicyEvent, ctx: PolicyContext, a: AnswersFor<Q>): string;
  /** `updated_input` for a `rewrite`; null means no rewrite is possible. */
  rewrite?(e: PolicyEvent, ctx: PolicyContext, a: AnswersFor<Q>): Record<string, unknown> | null;
  /** Context note for an `annotate`. */
  contextNote?(e: PolicyEvent, ctx: PolicyContext, a: AnswersFor<Q>): string | null;
  readonly range?: readonly [Verdict, Verdict];
  readonly fallback?: Verdict;
}

/**
 * A human-granted precedent that matches this event (spec §Precedents). `riskDelta` is
 * capped at 0.3 by the engine; `policies` names the policies whose non-deny verdict the
 * human overrode. Ignored entirely when any policy returns `kill`.
 */
export interface PrecedentMatch {
  readonly key: string;
  readonly riskDelta: number;
  readonly policies: readonly string[];
}

/** Precedent store the daemon supplies (M0 step 8); synchronous (bun:sqlite). */
export interface PrecedentLookup {
  lookup(e: PolicyEvent, ctx: PolicyContext): PrecedentMatch | null;
}

/** What the daemon wires into the engine once, at start or on policy reload. */
export interface PolicyEngineOptions {
  policies: readonly PolicyDefinition[];
  /** Any provider; the engine always adds the question limit, validation and timeout. */
  judge: Judge;
  contextConfig?: ContextConfig;
  policyConfig?: PolicyConfig;
  /** Clock for budget charges; `Date.now` by default. */
  now?: () => number;
  precedents?: PrecedentLookup;
}

/** Per-event facts the daemon knows and the event does not carry. */
export interface JudgeCallOptions {
  /** `~`/`$HOME` for path expansion: daemon config, never the event (D-003). */
  home: string;
  repoHints?: RepoHints;
}

/** The decision plus the readings it was made from (for the audit log and `explain`). */
export interface Judgement {
  decision: Decision;
  normalized: NormalizedEvent;
  features: FeatureResult;
}

/** The daemon's only entry point into judging. */
export interface PolicyEngine {
  judge(event: PreEvent, casefile: CaseFile, opts: JudgeCallOptions): Promise<Judgement>;
  observe(event: PostEvent, casefile: CaseFile, opts: JudgeCallOptions): Promise<NormalizedEvent>;
}
