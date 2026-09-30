import type { AuditLine, ChainHead } from "../audit-line.ts";
import { findLastLine } from "../audit-read.ts";
import {
  type CheckpointReason,
  parseCheckpoint,
  type SignedCheckpoint,
  signCheckpoint,
} from "./checkpoint.ts";
import type { CheckpointSigner } from "./keys.ts";

/** How the audit log signs: the key (null: unsigned) and the interval in lines. */
export interface SigningOptions {
  readonly signer: CheckpointSigner | null;
  readonly every: number;
}

/** What `/v1/health` reports about signing. */
export interface SigningStatus {
  /** The key the daemon signs with; null when it runs unsigned. */
  readonly keyId: string | null;
  readonly every: number;
  /** Seq of the log's last checkpoint line; 0 when none. */
  readonly lastCheckpointSeq: number;
  /** The key the log's last checkpoint puts in force (a rotation's next key); null when none. */
  readonly inForce: string | null;
}

interface Last {
  readonly seq: number;
  readonly hash: string;
  readonly inForce: string;
}

function lastOf(line: AuditLine): Last | null {
  const parsed = parseCheckpoint(line.payload);
  if (!parsed.ok) return null;
  const c = parsed.value;
  return { seq: line.seq, hash: line.hash, inForce: c.next_key_id ?? c.key_id };
}

/**
 * The checkpoint state of one audit log (D-104): the last checkpoint line, when the next
 * interval checkpoint is due, and the signed statement for a new one. It never writes.
 */
export class Checkpointer {
  private constructor(
    private signer: CheckpointSigner | null,
    private readonly every: number,
    private last: Last | null,
  ) {}

  /** The state of the log at `path`: its last well-formed checkpoint line, if any. */
  static fromLog(path: string, opts: SigningOptions): Checkpointer {
    const found = findLastLine(path, (l) => l.kind === "checkpoint" && lastOf(l) !== null);
    return new Checkpointer(opts.signer, opts.every, found === null ? null : lastOf(found.line));
  }

  /** True when `head` completes an interval (and there is a key to sign with). */
  due(head: ChainHead): boolean {
    return this.signer !== null && head.seq - (this.last?.seq ?? 0) >= this.every;
  }

  /**
   * The signed statement for a checkpoint line following `head`, or null without a key or
   * when no line was appended since the last checkpoint (a rotation is always signed).
   */
  statement(
    reason: CheckpointReason,
    head: ChainHead,
    at: number,
    next?: CheckpointSigner,
  ): SignedCheckpoint | null {
    const signer = this.signer;
    const count = head.seq - (this.last?.seq ?? 0);
    if (signer === null || (count === 0 && reason !== "rotation")) return null;
    const prev = this.last === null ? null : { seq: this.last.seq, hash: this.last.hash };
    const rotation =
      next === undefined ? {} : { next_key_id: next.keyId, next_public_key: next.publicKeyPem };
    return signCheckpoint(
      {
        alg: "ed25519",
        key_id: signer.keyId,
        head_seq: head.seq,
        head_hash: head.hash,
        count,
        every: this.every,
        prev_checkpoint: prev,
        reason,
        at,
        ...rotation,
      },
      signer,
    );
  }

  /** Records a checkpoint line as written; after a rotation, `next` signs from now on. */
  written(line: AuditLine, next?: CheckpointSigner): void {
    this.last = lastOf(line);
    if (next !== undefined) this.signer = next;
  }

  /** True when there is a key to sign with. */
  hasKey(): boolean {
    return this.signer !== null;
  }

  status(): SigningStatus {
    return {
      keyId: this.signer?.keyId ?? null,
      every: this.every,
      lastCheckpointSeq: this.last?.seq ?? 0,
      inForce: this.last?.inForce ?? null,
    };
  }
}
