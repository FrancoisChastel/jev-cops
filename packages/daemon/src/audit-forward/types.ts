import type { AuditLine, ChainHead } from "../audit-line.ts";

/**
 * Off-box shipping of the audit log (D-103): the local append-only JSONL stays the primary
 * log and the queue; a forwarder ships each line to one destination behind this interface,
 * so S3 or a SIEM API is a third implementation with the same line format.
 */

/** Which destination a forwarder ships to. */
export type ForwarderKind = "file" | "syslog";

/** What `/v1/health` and `cops doctor` report about a forwarder. */
export interface ForwarderStatus {
  readonly kind: ForwarderKind;
  readonly connected: boolean;
  /** Last seq handed to the destination (the persisted cursor). */
  readonly sentSeq: number;
  /** Last seq appended to the local log. */
  readonly headSeq: number;
  /** Lines appended locally but not handed to the destination yet. */
  readonly lagLines: number;
  /** How long the forwarder has been behind; 0 when caught up. */
  readonly lagMs: number;
  readonly lastError: string | null;
  /** When the destination was lost; null while connected. */
  readonly downSince: number | null;
}

/** Ships audit lines off the box; never throws into the audit log and never blocks it. */
export interface AuditForwarder {
  /**
   * Reads the cursor, checks it against the local log's head and starts connecting in the
   * background. Problems found now or later (a cursor or a destination ahead of the log:
   * the local tail was cut; a line that differs from the one shipped) go to `report`, which
   * the log records as `anomaly` lines. Never throws.
   */
  open(head: ChainHead, report: (problem: string) => void): void;
  /** Hands over one line just appended locally; returns at once. */
  send(line: AuditLine): void;
  status(): ForwarderStatus;
  /** Resolves true once every line up to the head is handed over, false after `timeoutMs`. */
  flush(timeoutMs: number): Promise<boolean>;
  /** Flushes within `budgetMs` (default 2 s), closes the destination, persists the cursor. */
  close(budgetMs?: number): Promise<void>;
}
