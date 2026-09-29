import type { CallKind, Event } from "../schema/event.ts";

/** Why part of a command cannot be judged from its text alone. */
export const OPAQUE_REASONS = [
  "command-substitution",
  "process-substitution",
  "eval",
  "interpreter",
  "heredoc-exec",
  "decoded-pipe",
  "dynamic-expansion",
  "parse-error",
] as const;

/** One of {@link OPAQUE_REASONS}. */
export type OpaqueReason = (typeof OPAQUE_REASONS)[number];

/** A construct whose effect is unknown until run time; `span` is its source text. */
export interface OpaqueSpan {
  reason: OpaqueReason;
  span: string;
}

/** HTTP methods a net command can be classified with; anything else is `OTHER`. */
export const NET_METHODS = ["GET", "POST", "PUT", "DELETE", "PATCH", "OTHER"] as const;

/** One of {@link NET_METHODS}. */
export type NetMethod = (typeof NET_METHODS)[number];

/** What a command does to a path it names; `unknown` when the verb is not a file verb. */
export type PathAccess = "read" | "write" | "delete" | "exec" | "unknown";

/** A path as written (`raw`) and as resolved (`path`: absolute, normalized, no FS access). */
export interface PathRef {
  raw: string;
  path: string;
  access: PathAccess;
}

/** A shell redirect; `target` is the expanded word (an fd number for `2>&1`). */
export interface Redirect {
  op: string;
  target: string;
}

/** A literal argument word that decoded to printable text. */
export interface DecodedLiteral {
  encoding: "base64" | "hex";
  raw: string;
  decoded: string;
}

/** One simple command after flattening pipes, lists, subshells and interpreter strings. */
export interface NormalizedCommand {
  /** Command name and arguments; literal words decoded and `~`/`$HOME` expanded, dynamic words verbatim. */
  argv: string[];
  /** `NAME=value` assignments written before the command (and those given to `env`). */
  env: Record<string, string>;
  redirects: Redirect[];
  /** Heredoc and herestring bodies fed to this command, verbatim. */
  heredocs: string[];
  /** The command's source slice. */
  raw: string;
  /** Per-command classification; see {@link NormalizedEvent.kind} for the event-level rule. */
  kind: CallKind;
  /** Absolute paths and lower-case hosts this command touches. */
  targets: { paths: string[]; hosts: string[] };
  /** Every path with the word it came from and how it is accessed. */
  pathRefs: PathRef[];
  /** e.g. `["rm","recursive","force"]`, `["git","push","force","irreversible"]`. */
  verbs: string[];
  /** True for `sh -c`, `python -c`, `node -e`, `eval`, `source`, a shell reading stdin, … */
  isInterpreter: boolean;
  /** True when this command came from an interpreter string, `eval` or a decoded payload. */
  viaInterpreter: boolean;
  /** HTTP method, set only for `curl` and `wget`. */
  method?: NetMethod;
}

/** A canonical event plus the daemon's own reading of what it does. */
export interface NormalizedEvent {
  event: Event;
  /**
   * Event-level kind, computed by {@link eventKind}: `exec` when anything is opaque
   * or an interpreter, else the most severe command kind in the order
   * fs.delete > net > fs.write > spawn > exec > fs.read > other.
   */
  kind: CallKind;
  commands: NormalizedCommand[];
  /** Union over commands, absolute and expanded, first-seen order. */
  paths: string[];
  hosts: string[];
  opaque: OpaqueSpan[];
  decodedLiterals: DecodedLiteral[];
  /** sha256 of the normalized shape; stable across whitespace and quoting, keys the judge cache. */
  stateHash: string;
  /** The original command (Bash) or `JSON.stringify(input)`; never truncated (T8). */
  raw: string;
}

/** The bash-derived part of a {@link NormalizedEvent}. */
export type NormalizedScript = Pick<
  NormalizedEvent,
  "commands" | "paths" | "hosts" | "opaque" | "decodedLiterals" | "kind"
>;
