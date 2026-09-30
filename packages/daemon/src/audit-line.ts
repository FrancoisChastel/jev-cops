import { canonicalJson, sha256Hex } from "@jev-cops/core";

/** `prev` of the first line of a chain. */
export const AUDIT_GENESIS = "0".repeat(64);

/** What an audit line records; `checkpoint` lines are signed statements of the chain (D-104). */
export const AUDIT_KINDS = [
  "judge",
  "observe",
  "anomaly",
  "precedent",
  "boot",
  "session",
  "checkpoint",
] as const;
export type AuditKind = (typeof AUDIT_KINDS)[number];

/** What a caller appends; the log adds `seq`, `at`, `prev` and `hash`. */
export interface AuditEntry {
  readonly kind: AuditKind;
  readonly event_id?: string;
  readonly session_id?: string;
  readonly payload: Readonly<Record<string, unknown>>;
}

/** One JSONL line: `hash = sha256(prev + canonicalJSON(line without hash))`. */
export interface AuditLine extends AuditEntry {
  readonly seq: number;
  readonly at: number;
  readonly prev: string;
  readonly hash: string;
}

/** The last line of a chain: what the next line's `prev` and `seq` follow. */
export interface ChainHead {
  readonly seq: number;
  readonly hash: string;
}

/** The hash a line must carry, computed over every field but `hash`. */
export function lineHash(line: Omit<AuditLine, "hash">): string {
  return sha256Hex(`${line.prev}${canonicalJson(line)}`);
}

/** True when the line's `hash` recomputes from its other fields. */
export function hashMatches(line: AuditLine): boolean {
  const { hash, ...rest } = line;
  return lineHash(rest) === hash;
}

function isLine(value: unknown): value is AuditLine {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.seq === "number" &&
    typeof v.at === "number" &&
    typeof v.prev === "string" &&
    typeof v.hash === "string" &&
    typeof v.kind === "string" &&
    typeof v.payload === "object" &&
    v.payload !== null
  );
}

/** Parses one line; null when it is not a well-formed audit line. */
export function parseLine(text: string): AuditLine | null {
  try {
    const value: unknown = JSON.parse(text);
    return isLine(value) ? value : null;
  } catch {
    return null;
  }
}

/** The exact text a line is written as (without the newline): canonical JSON. */
export function lineText(line: AuditLine): string {
  return canonicalJson(line);
}
