import { closeSync, existsSync, fstatSync, openSync, readSync } from "node:fs";
import { type AuditLine, parseLine } from "./audit-line.ts";

/**
 * Reading the audit file without loading it whole: its tail on open, the last line that
 * matches (the last checkpoint), the offset after a given seq (the forward cursor), and
 * complete lines forward from an offset (the forwarder's catch-up). Lines are split on the
 * newline byte, which never occurs inside a multi-byte UTF-8 sequence.
 */

const CHUNK = 64 * 1024;
const NEWLINE = 0x0a;

/** One line of the file: its text (no newline) and the offset just after its newline. */
interface Span {
  readonly text: string;
  readonly end: number;
}

function withFile<T>(path: string, empty: T, fn: (fd: number, size: number) => T): T {
  if (!existsSync(path)) return empty;
  const fd = openSync(path, "r");
  try {
    return fn(fd, fstatSync(fd).size);
  } finally {
    closeSync(fd);
  }
}

function readAt(fd: number, start: number, length: number): Buffer {
  const buf = Buffer.alloc(length);
  const n = readSync(fd, buf, 0, length, start);
  return n === length ? buf : buf.subarray(0, n);
}

/**
 * The file's lines from the last to the first. `pending` holds the unread bytes
 * `[pos, pendingEnd)`; a line is the bytes after the last newline before its own end.
 */
function* backward(fd: number, size: number, chunk: number): Generator<Span> {
  let pos = size;
  let pending: Buffer = Buffer.alloc(0);
  let pendingEnd = size;
  while (pendingEnd > 0) {
    const k = pending.length < 2 ? -1 : pending.lastIndexOf(NEWLINE, pending.length - 2);
    if (k === -1 && pos > 0) {
      const start = Math.max(0, pos - chunk);
      pending = Buffer.concat([readAt(fd, start, pos - start), pending]);
      pos = start;
      continue;
    }
    const lineStart = k + 1;
    const body = pending.subarray(lineStart);
    const text = body.at(-1) === NEWLINE ? body.subarray(0, -1) : body;
    yield { text: text.toString("utf8"), end: pendingEnd };
    pending = pending.subarray(0, lineStart);
    pendingEnd = pos + lineStart;
  }
}

/** The file's last non-empty line (null when none) and whether it ends with a newline. */
export function readTailLine(path: string): { last: string | null; endsWithNewline: boolean } {
  return withFile(path, { last: null, endsWithNewline: true }, (fd, size) => {
    if (size === 0) return { last: null, endsWithNewline: true };
    const endsWithNewline = readAt(fd, size - 1, 1)[0] === NEWLINE;
    for (const span of backward(fd, size, CHUNK)) {
      if (span.text !== "") return { last: span.text, endsWithNewline };
    }
    return { last: null, endsWithNewline };
  });
}

/** The last well-formed line matching `pred`, with the offset after it; null when none. */
export function findLastLine(
  path: string,
  pred: (line: AuditLine) => boolean,
  chunk = CHUNK,
): { line: AuditLine; end: number } | null {
  return withFile(path, null, (fd, size) => {
    for (const span of backward(fd, size, chunk)) {
      const line = parseLine(span.text);
      if (line !== null && pred(line)) return { line, end: span.end };
    }
    return null;
  });
}

/**
 * Where reading resumes after line `seq`: the offset just after it and its hash. Seq 0,
 * or a seq below every line of the file, is the start (hash null). Null when the file has
 * no line with that seq although it has lines above it (a gap or a rewrite) or none above.
 */
export function lineEndAfter(
  path: string,
  seq: number,
): { offset: number; hash: string | null } | null {
  if (seq <= 0) return { offset: 0, hash: null };
  return withFile(path, null, (fd, size) => {
    let sawAbove = false;
    for (const span of backward(fd, size, CHUNK)) {
      const line = parseLine(span.text);
      if (line === null) continue;
      if (line.seq === seq) return { offset: span.end, hash: line.hash };
      if (line.seq < seq) return null;
      sawAbove = true;
    }
    return sawAbove ? { offset: 0, hash: null } : null;
  });
}

/** Complete lines read forward from an offset. */
export interface ForwardRead {
  /** Well-formed lines, each with the offset just after it. */
  readonly lines: ReadonlyArray<{ readonly line: AuditLine; readonly end: number }>;
  /** The file's size when read (smaller than the offset: the file was cut or replaced). */
  readonly size: number;
  /** The offset to resume from: after the last complete line looked at, garbage included. */
  readonly consumed: number;
}

/** Up to `maxLines` well-formed complete lines from `offset`; unparseable lines are skipped. */
export function readLinesFrom(
  path: string,
  offset: number,
  maxLines: number,
  chunk = CHUNK,
): ForwardRead {
  return withFile(path, { lines: [], size: 0, consumed: offset }, (fd, size) => {
    const lines: { line: AuditLine; end: number }[] = [];
    let consumed = offset;
    let buf: Buffer = Buffer.alloc(0);
    let pos = offset;
    while (lines.length < maxLines && pos < size) {
      buf = Buffer.concat([buf, readAt(fd, pos, Math.min(chunk, size - pos))]);
      pos += Math.min(chunk, size - pos);
      let nl = buf.indexOf(NEWLINE);
      while (nl !== -1 && lines.length < maxLines) {
        consumed += nl + 1;
        const line = parseLine(buf.subarray(0, nl).toString("utf8"));
        if (line !== null) lines.push({ line, end: consumed });
        buf = buf.subarray(nl + 1);
        nl = buf.indexOf(NEWLINE);
      }
    }
    return { lines, size, consumed };
  });
}
