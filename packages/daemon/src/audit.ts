import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  writeSync,
} from "node:fs";
import { dirname } from "node:path";
import { canonicalJson, sha256Hex } from "@jev-cops/core";
import type { AuditForwarder } from "./audit-forward/types.ts";
import {
  AUDIT_GENESIS,
  type AuditEntry,
  type AuditLine,
  type ChainHead,
  lineHash,
  parseLine,
} from "./audit-line.ts";
import { findLastLine, readTailLine } from "./audit-read.ts";
import type { CheckpointReason } from "./audit-sign/checkpoint.ts";
import {
  Checkpointer,
  type SigningOptions,
  type SigningStatus,
} from "./audit-sign/checkpointer.ts";
import type { CheckpointSigner } from "./audit-sign/keys.ts";

export {
  AUDIT_GENESIS,
  AUDIT_KINDS,
  type AuditEntry,
  type AuditKind,
  type AuditLine,
  type ChainHead,
  hashMatches,
  lineHash,
  lineText,
  parseLine,
} from "./audit-line.ts";

/** Default `[audit] checkpoint_every`. */
export const DEFAULT_CHECKPOINT_EVERY = 100;

/** Outcome of {@link verifyChain}; `brokenAt` is the seq of the first bad line. */
export interface ChainReport {
  readonly ok: boolean;
  readonly lines: number;
  readonly brokenAt?: number;
  readonly reason?: string;
}

/** JSON round trip: drops `undefined`, so the hashed value is exactly the written one. */
function plain<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/** Options for {@link AuditLog.open}. */
export interface AuditOptions {
  now?: () => number;
  /** Ships every line off the box (`[audit.forward]`); null or absent: local only. */
  forwarder?: AuditForwarder | null;
  /** The checkpoint key and interval; absent: unsigned, every 100 lines. */
  signing?: SigningOptions | null;
}

/** The checkpoint reasons a caller asks for; a rotation goes through {@link AuditLog.rotate}. */
export type CheckpointRequest = Exclude<CheckpointReason, "rotation">;

/**
 * The append-only, hash-chained JSONL audit log (spec §Stores, T12). The file is opened
 * with `O_APPEND` and mode 0600; each line is written with one synchronous `write`, so
 * lines never interleave and nothing is buffered. On open the chain continues from the
 * last line; an unparseable tail restarts it with an `anomaly` line whose `prev` is the
 * hash of that tail, which {@link verifyChain} reports as a break. Every line is handed to
 * the forwarder after it is written; with a key, a signed `checkpoint` line follows every
 * `every` lines and wherever the daemon asks for one (D-104).
 */
export class AuditLog {
  private seq: number;
  private prev: string;
  private readonly tailAnomaly: string | null;
  private closed = false;

  private constructor(
    readonly path: string,
    private readonly fd: number,
    private readonly now: () => number,
    private readonly forwarder: AuditForwarder | null,
    private readonly checkpoints: Checkpointer,
  ) {
    const tail = readTailLine(path);
    const parsed = tail.last === null ? null : parseLine(tail.last);
    const lastGood = findLastLine(path, () => true)?.line ?? null;
    if (!tail.endsWithNewline) writeSync(fd, "\n");
    this.seq = lastGood?.seq ?? 0;
    this.prev = parsed?.hash ?? (tail.last === null ? AUDIT_GENESIS : sha256Hex(tail.last));
    this.tailAnomaly = tail.last !== null && parsed === null ? "audit tail unparseable" : null;
  }

  /** Opens (creating directories and the file, 0600) for appending. */
  static open(path: string, opts: AuditOptions = {}): AuditLog {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const fd = openSync(path, "a+", 0o600);
    const signing = opts.signing ?? { signer: null, every: DEFAULT_CHECKPOINT_EVERY };
    const checkpoints = Checkpointer.fromLog(path, signing);
    const log = new AuditLog(path, fd, opts.now ?? Date.now, opts.forwarder ?? null, checkpoints);
    log.forwarder?.open(log.head(), (reason) => log.forwarderProblem(reason));
    if (log.tailAnomaly !== null) {
      log.append({ kind: "anomaly", payload: { reason: log.tailAnomaly, chain: "restarted" } });
    }
    return log;
  }

  /** A forwarder's problem as an `anomaly` line; dropped once the log is closed (shutdown). */
  private forwarderProblem(reason: string): void {
    if (!this.closed) this.append({ kind: "anomaly", payload: { reason, source: "forwarder" } });
  }

  /**
   * Appends one line and returns it as written, then an interval checkpoint when one is
   * due. Throws once closed (a closed descriptor's number can be reused by another file, so
   * a late write must never reach it) and for `checkpoint` entries, which only
   * {@link checkpoint} and {@link rotate} write.
   */
  append(entry: AuditEntry): AuditLine {
    if (entry.kind === "checkpoint") throw new Error("checkpoint lines are signed, not appended");
    const line = this.write(entry, this.now());
    if (this.checkpoints.due(this.head())) this.checkpoint("interval");
    return line;
  }

  /**
   * Appends a checkpoint signing the chain through the current head (session end, boot,
   * shutdown). Null without a key, or when no line was appended since the last checkpoint.
   */
  checkpoint(reason: CheckpointRequest): AuditLine | null {
    const at = this.now();
    const statement = this.checkpoints.statement(reason, this.head(), at);
    if (statement === null) return null;
    const line = this.write({ kind: "checkpoint", payload: statement }, at);
    this.checkpoints.written(line);
    return line;
  }

  /**
   * Key rotation: a checkpoint signed by the current key naming `next` (its id and public
   * key), after which `next` signs. Throws without a current key.
   */
  rotate(next: CheckpointSigner): AuditLine {
    const at = this.now();
    const statement = this.checkpoints.hasKey()
      ? this.checkpoints.statement("rotation", this.head(), at, next)
      : null;
    if (statement === null) throw new Error("no current key to sign the rotation with");
    const line = this.write({ kind: "checkpoint", payload: statement }, at);
    this.checkpoints.written(line, next);
    return line;
  }

  /** Signs with `signer` from now on, which the log's last rotation already named. */
  adoptKey(signer: CheckpointSigner): void {
    this.checkpoints.adopt(signer);
  }

  /** The last line written: what the next line follows. */
  head(): ChainHead {
    return { seq: this.seq, hash: this.prev };
  }

  /** The signing key, interval and last checkpoint. */
  signing(): SigningStatus {
    return this.checkpoints.status();
  }

  /** Flushes to disk and closes; later appends throw. Idempotent. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    fsyncSync(this.fd);
    closeSync(this.fd);
  }

  private write(entry: AuditEntry, at: number): AuditLine {
    if (this.closed) throw new Error(`audit log ${this.path} is closed`);
    const body = plain({ ...entry, seq: this.seq + 1, at, prev: this.prev });
    const line: AuditLine = { ...body, hash: lineHash(body) };
    writeSync(this.fd, `${canonicalJson(line)}\n`);
    this.seq = line.seq;
    this.prev = line.hash;
    this.forward(line);
    return line;
  }

  /** The forwarder records its own failures (`status().lastError`); none may fail an append. */
  private forward(line: AuditLine): void {
    try {
      this.forwarder?.send(line);
    } catch {
      // A forwarder is contractually non-throwing; this guard keeps the local log primary.
    }
  }
}

/** Every well-formed line of an audit file, and one problem per malformed line. */
export function readAudit(path: string): { lines: AuditLine[]; problems: string[] } {
  if (!existsSync(path)) return { lines: [], problems: [] };
  const lines: AuditLine[] = [];
  const problems: string[] = [];
  readFileSync(path, "utf8")
    .split("\n")
    .forEach((text, i) => {
      if (text === "") return;
      const line = parseLine(text);
      if (line === null) problems.push(`line ${i + 1}: not a valid audit line`);
      else lines.push(line);
    });
  return { lines, problems };
}

/** Why `text` does not continue a chain at `prevSeq`/`prevHash`, or null when it does. */
export function checkLine(text: string, prevSeq: number, prevHash: string): string | null {
  const line = parseLine(text);
  if (line === null) return "unparseable line";
  if (line.seq !== prevSeq + 1) return `seq ${line.seq} follows ${prevSeq}`;
  if (line.prev !== prevHash) return "prev does not match the previous line's hash";
  const { hash, ...rest } = line;
  return lineHash(rest) === hash ? null : "hash does not match the line";
}

/** The non-empty lines of a file (missing: none). */
export function auditTexts(path: string): string[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((t) => t !== "");
}

/**
 * Verifies the chain (T12): every line parses, `seq` increases by one from 1, `prev`
 * is the previous line's hash (the genesis constant first) and `hash` recomputes. A cut
 * tail leaves a valid shorter chain: the signed checkpoints and the off-box copy cover
 * that (`verifyAudit`, `compareCopies`).
 */
export function verifyChain(path: string): ChainReport {
  const texts = auditTexts(path);
  let prevSeq = 0;
  let prevHash = AUDIT_GENESIS;
  for (const text of texts) {
    const problem = checkLine(text, prevSeq, prevHash);
    if (problem !== null) {
      const brokenAt = parseLine(text)?.seq ?? prevSeq + 1;
      return { ok: false, lines: texts.length, brokenAt, reason: problem };
    }
    const line = parseLine(text) as AuditLine;
    prevSeq = line.seq;
    prevHash = line.hash;
  }
  return { ok: true, lines: texts.length };
}
