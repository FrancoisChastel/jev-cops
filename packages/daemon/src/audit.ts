import {
  closeSync,
  existsSync,
  fstatSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  writeSync,
} from "node:fs";
import { dirname } from "node:path";
import { canonicalJson, sha256Hex } from "@jev-cops/core";

/** `prev` of the first line of a chain. */
export const AUDIT_GENESIS = "0".repeat(64);

/** What an audit line records. */
export const AUDIT_KINDS = ["judge", "observe", "anomaly", "precedent", "boot", "session"] as const;
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

/** Outcome of {@link verifyChain}; `brokenAt` is the seq of the first bad line. */
export interface ChainReport {
  readonly ok: boolean;
  readonly lines: number;
  readonly brokenAt?: number;
  readonly reason?: string;
}

/** The hash a line must carry, computed over every field but `hash`. */
export function lineHash(line: Omit<AuditLine, "hash">): string {
  return sha256Hex(`${line.prev}${canonicalJson(line)}`);
}

/** JSON round trip: drops `undefined`, so the hashed value is exactly the written one. */
function plain<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
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

const TAIL_CHUNK = 64 * 1024;

/** The tail of an open file: its last lines (at least one whole line) and final byte. */
function readTail(fd: number): { lines: string[]; endsWithNewline: boolean } {
  const size = fstatSync(fd).size;
  let text = "";
  for (let end = size; end > 0; ) {
    const start = Math.max(0, end - TAIL_CHUNK);
    const buf = Buffer.alloc(end - start);
    readSync(fd, buf, 0, buf.length, start);
    text = buf.toString("utf8") + text;
    const lines = text.split("\n").filter((l) => l !== "");
    if (lines.length > 1 || start === 0) {
      return { lines: start === 0 ? lines : lines.slice(1), endsWithNewline: text.endsWith("\n") };
    }
    end = start;
  }
  return { lines: [], endsWithNewline: true };
}

/** Options for {@link AuditLog.open}. */
export interface AuditOptions {
  now?: () => number;
  /** A file every line is also appended to (the M0 subset of `[audit.forward]`). */
  forward?: string | null;
}

/**
 * The append-only, hash-chained JSONL audit log (spec §Stores, T12). The file is opened
 * with `O_APPEND` and mode 0600; each line is written with one synchronous `write`, so
 * lines never interleave and nothing is buffered. On open the chain continues from the
 * last line; an unparseable tail restarts it with an `anomaly` line whose `prev` is the
 * hash of that tail, which {@link verifyChain} reports as a break.
 */
export class AuditLog {
  private seq: number;
  private prev: string;
  private pendingAnomaly: string | null;
  private closed = false;

  private constructor(
    readonly path: string,
    private readonly fd: number,
    private readonly forwardFd: number | null,
    private readonly now: () => number,
  ) {
    const tail = readTail(fd);
    const last = tail.lines.at(-1) ?? null;
    const parsed = last === null ? null : parseLine(last);
    const lastGood = tail.lines.map(parseLine).findLast((l) => l !== null) ?? null;
    if (!tail.endsWithNewline) writeSync(fd, "\n");
    this.seq = lastGood?.seq ?? 0;
    this.prev = parsed?.hash ?? (last === null ? AUDIT_GENESIS : sha256Hex(last));
    this.pendingAnomaly = last !== null && parsed === null ? "audit tail unparseable" : null;
  }

  /** Opens (creating directories and the file, 0600) for appending. */
  static open(path: string, opts: AuditOptions = {}): AuditLog {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const fd = openSync(path, "a+", 0o600);
    const fwd = opts.forward ?? null;
    if (fwd !== null) mkdirSync(dirname(fwd), { recursive: true, mode: 0o700 });
    const forwardFd = fwd === null ? null : openSync(fwd, "a", 0o600);
    const log = new AuditLog(path, fd, forwardFd, opts.now ?? Date.now);
    if (log.pendingAnomaly !== null) {
      log.append({ kind: "anomaly", payload: { reason: log.pendingAnomaly, chain: "restarted" } });
      log.pendingAnomaly = null;
    }
    return log;
  }

  /**
   * Appends one line and returns it as written. Throws once closed: a closed descriptor's
   * number can be reused by another file, so a late write must never reach it.
   */
  append(entry: AuditEntry): AuditLine {
    if (this.closed) throw new Error(`audit log ${this.path} is closed`);
    const body = plain({ ...entry, seq: this.seq + 1, at: this.now(), prev: this.prev });
    const line: AuditLine = { ...body, hash: lineHash(body) };
    const text = `${canonicalJson(line)}\n`;
    writeSync(this.fd, text);
    if (this.forwardFd !== null) writeSync(this.forwardFd, text);
    this.seq = line.seq;
    this.prev = line.hash;
    return line;
  }

  /** Flushes to disk and closes; later appends throw. Idempotent. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const fd of [this.fd, this.forwardFd]) {
      if (fd === null) continue;
      fsyncSync(fd);
      closeSync(fd);
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

function checkLine(text: string, prevSeq: number, prevHash: string): string | null {
  const line = parseLine(text);
  if (line === null) return "unparseable line";
  if (line.seq !== prevSeq + 1) return `seq ${line.seq} follows ${prevSeq}`;
  if (line.prev !== prevHash) return "prev does not match the previous line's hash";
  const { hash, ...rest } = line;
  return lineHash(rest) === hash ? null : "hash does not match the line";
}

/**
 * Verifies the chain (T12): every line parses, `seq` increases by one from 1, `prev`
 * is the previous line's hash (the genesis constant first) and `hash` recomputes. Tail
 * truncation leaves a valid shorter chain; that is what shipping the log off-box covers.
 */
export function verifyChain(path: string): ChainReport {
  if (!existsSync(path)) return { ok: true, lines: 0 };
  const texts = readFileSync(path, "utf8")
    .split("\n")
    .filter((t) => t !== "");
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
