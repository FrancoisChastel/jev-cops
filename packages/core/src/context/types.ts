import type { NormalizedEvent } from "../normalizer/types.ts";
import type { CallKind, Phase } from "../schema/event.ts";
import type { RiskBudget } from "./budget.ts";

/** One tool call as the case file remembers it; `phase` is `post` once its result arrived. */
export interface CallRecord {
  callId: string;
  /** The session that issued the call (a subagent writes into its parent's case file). */
  sessionId: string;
  at: number;
  phase: Phase;
  kind: CallKind;
  verbs: string[];
  paths: string[];
  hosts: string[];
  /** Every command's argv, flattened in order. */
  argv: string[];
  /** Taint fraction the daemon scored for the pre event (0 when not given). */
  taint: number;
  ok?: boolean;
  exitCode?: number;
}

/** A read of a secret: by path glob at pre time, or by a content pattern in the post head. */
export interface SecretRead {
  /** The secret path, or `stdout:<callId>` when the output matched but no path was read. */
  path: string;
  callId: string;
  at: number;
  reason: "path-glob" | "content-pattern";
}

/** The latest agent write to a path; `taint` is the max over every write to it. */
export interface FileWrite {
  path: string;
  /** sha256 of the full content when the tool input carries it (Write, heredoc). */
  sha256?: string;
  taint: number;
  callId: string;
  at: number;
  /** Set once the agent made it executable (`chmod +x`, `chmod 755`). */
  executable?: boolean;
}

/** Who first contacted a host, and when. */
export interface HostSeen {
  at: number;
  callId: string;
}

/** A string seen in tool output; a pre event using it scores as tainted. */
export interface TaintEntry {
  value: string;
  sourceCallId: string;
  at: number;
  /** Taint level in (0, 1]: the source's own taint, or a self-written file's if higher. */
  taint: number;
}

/** Optional taint the daemon computed for an event, passed when recording it. */
export interface RecordExtra {
  taint: number;
}

/**
 * The per-session record the context engine maintains (spec §Session case file). Every
 * read returns fresh copies; `task` is set once and then immutable (T11); a subagent's
 * case file is its parent's, read and written by reference.
 */
export interface CaseFile {
  readonly sessionId: string;
  readonly parentId: string | null;
  readonly task: string | null;
  readonly budget: RiskBudget;
  /** The injected clock; every window is measured against it. */
  now(): number;
  /** First non-empty task wins; a later, different task is ignored and logged. */
  setTaskOnce(task: string): void;
  recordPre(n: NormalizedEvent, extra?: RecordExtra): void;
  /** Pairs with the pre record by `call.id`; registers taint, secret reads and failures. */
  recordPost(n: NormalizedEvent, extra?: RecordExtra): void;
  setBudget(budget: RiskBudget): void;
  taintSet(): ReadonlyArray<TaintEntry>;
  /** Secret reads at or after the absolute time `at` (ms since epoch). */
  secretReadsSince(at: number): SecretRead[];
  /** Host → first time it was contacted. */
  hostsSeen(): ReadonlyMap<string, number>;
  /** Host → the call that first contacted it; lets a judged call exclude its own record. */
  hostsFirstSeen(): ReadonlyMap<string, HostSeen>;
  filesWritten(): ReadonlyMap<string, FileWrite>;
  failuresInARow(): number;
  /** Calls at or after `now() - windowMs`, oldest first. */
  recentCalls(windowMs: number): CallRecord[];
  /** Things that should not happen (post before pre, task rewrites), oldest first. */
  anomalies(): string[];
}
