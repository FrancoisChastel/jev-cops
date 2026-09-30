import type { AuditLine, ChainHead } from "../audit-line.ts";
import { lineEndAfter, readLinesFrom } from "../audit-read.ts";
import { readCursor, writeCursor } from "./cursor.ts";
import type { AuditForwarder, ForwarderKind, ForwarderStatus } from "./types.ts";

/** One destination's connection, as the forwarder drives it. */
export interface ForwardTransport {
  readonly kind: ForwarderKind;
  /** The destination: a path, or host:port. */
  readonly target: string;
  /** Lines resent before the cursor after an unclean stop (no acknowledgement to trust). */
  readonly resendOverlap: number;
  /** Opens the destination; rejects when it cannot. */
  connect(): Promise<void>;
  /** The last line the destination is known to hold, when it can tell (a file copy); else null. */
  delivered(): ChainHead | null;
  /** Writes the lines in order; resolves once handed to the OS, rejects when the destination is lost. */
  write(lines: readonly AuditLine[]): Promise<void>;
  /** Called when the destination drops on its own (the peer closed). */
  onDrop(callback: (reason: string) => void): void;
  /** Closes gracefully; resolves true when every written byte was handed over cleanly. */
  close(): Promise<boolean>;
}

/** Where a forwarder reads from and persists to, and how it retries. */
export interface ForwarderOptions {
  readonly logPath: string;
  readonly cursorPath: string;
  readonly now?: () => number;
  /** Reconnect backoff: doubles from `minMs` to `maxMs` (default 250 ms to 30 s). */
  readonly retry?: { readonly minMs: number; readonly maxMs: number };
  /** Lines per write (default 256). */
  readonly batchLines?: number;
}

const DEFAULT_RETRY = { minMs: 250, maxMs: 30_000 };
const DEFAULT_BATCH = 256;
const CLOSE_BUDGET_MS = 2_000;

function message(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/**
 * A forwarder over any transport (D-103). The local log is the queue: each batch is read
 * from the file after the cursor, so lines appended while the destination is down are
 * shipped when it returns, and a restart resumes from the persisted cursor. Delivery is
 * at least once: after an unclean stop the last `resendOverlap` lines go again, and a
 * destination that knows what it holds (a file) resumes exactly after it.
 */
export class CursorForwarder implements AuditForwarder {
  private readonly now: () => number;
  private readonly retry: { readonly minMs: number; readonly maxMs: number };
  private readonly batch: number;
  private report: (problem: string) => void = () => {};
  private headSeq = 0;
  private sent: ChainHead = { seq: 0, hash: "" };
  private offset = 0;
  private uncertain = false;
  private connected = false;
  private connecting = false;
  private closed = false;
  private pumping: Promise<void> | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private retryMs: number;
  private lastError: string | null = null;
  private downSince: number | null = null;
  private behindSince: number | null = null;

  constructor(
    private readonly transport: ForwardTransport,
    private readonly opts: ForwarderOptions,
  ) {
    this.now = opts.now ?? Date.now;
    this.retry = opts.retry ?? DEFAULT_RETRY;
    this.batch = opts.batchLines ?? DEFAULT_BATCH;
    this.retryMs = this.retry.minMs;
    transport.onDrop((reason) => this.lost(reason));
  }

  open(head: ChainHead, report: (problem: string) => void): void {
    this.report = report;
    this.headSeq = head.seq;
    this.downSince = this.now();
    const problems = this.loadCursor(head);
    if (this.sent.seq < this.headSeq) this.behindSince = this.now();
    void this.connect();
    for (const p of problems) this.safeReport(p);
  }

  send(line: AuditLine): void {
    if (this.closed) return;
    if (this.behindSince === null && line.seq > this.sent.seq) this.behindSince = this.now();
    this.headSeq = Math.max(this.headSeq, line.seq);
    if (this.connected) this.schedulePump();
  }

  status(): ForwarderStatus {
    return {
      kind: this.transport.kind,
      connected: this.connected,
      sentSeq: this.sent.seq,
      headSeq: this.headSeq,
      lagLines: Math.max(0, this.headSeq - this.sent.seq),
      lagMs: this.behindSince === null ? 0 : Math.max(0, this.now() - this.behindSince),
      lastError: this.lastError,
      downSince: this.downSince,
    };
  }

  async flush(timeoutMs: number): Promise<boolean> {
    const deadline = performance.now() + timeoutMs;
    while (this.sent.seq < this.headSeq || this.pumping !== null) {
      if (performance.now() >= deadline) return false;
      await Bun.sleep(5);
    }
    return true;
  }

  async close(budgetMs = CLOSE_BUDGET_MS): Promise<void> {
    if (this.closed) return;
    if (this.connected) await this.flush(budgetMs);
    this.closed = true;
    if (this.timer !== null) clearTimeout(this.timer);
    const wasConnected = this.connected;
    this.connected = false;
    const graceful = await this.transport.close().catch(() => false);
    this.saveCursor(wasConnected && graceful && !this.uncertain);
  }

  /** Resumes after the persisted cursor; returns the problems it found with it. */
  private loadCursor(head: ChainHead): string[] {
    const { kind, target } = this.transport;
    const cursor = readCursor(this.opts.cursorPath, kind, target);
    if (cursor === null) {
      this.seek(0);
      return [];
    }
    this.uncertain = !cursor.clean;
    if (cursor.seq > head.seq) {
      this.seekHead(head);
      return [
        `forward cursor at seq ${cursor.seq} is past the log's last line ${head.seq}: the local tail was cut or the log replaced`,
      ];
    }
    const found = this.seek(cursor.seq);
    if (found === null)
      return [
        `forward cursor seq ${cursor.seq} is not in the log: shipping it again from the start`,
      ];
    if (cursor.seq > 0 && found !== cursor.hash) {
      return [
        `the log's line at seq ${cursor.seq} differs from the line shipped (hash ${cursor.hash}): the log was rewritten`,
      ];
    }
    return [];
  }

  /** Positions after line `seq`; null (and the start) when the log has no such line. */
  private seek(seq: number): string | null {
    const at = lineEndAfter(this.opts.logPath, seq);
    if (at === null) {
      this.sent = { seq: 0, hash: "" };
      this.offset = 0;
      return null;
    }
    this.sent = { seq: at.hash === null ? 0 : seq, hash: at.hash ?? "" };
    this.offset = at.offset;
    return at.hash ?? "";
  }

  private seekHead(head: ChainHead): void {
    if (this.seek(head.seq) === null) this.seek(0);
  }

  private async connect(): Promise<void> {
    if (this.closed || this.connecting || this.connected) return;
    this.connecting = true;
    try {
      await this.transport.connect();
    } catch (cause) {
      this.connecting = false;
      this.lost(message(cause));
      return;
    }
    this.connecting = false;
    if (this.closed) return;
    this.connected = true;
    this.downSince = null;
    this.retryMs = this.retry.minMs;
    this.resume();
    this.schedulePump();
  }

  /** After (re)connecting: exactly after what the destination holds, else overlap if unsure. */
  private resume(): void {
    const held = this.transport.delivered();
    if (held !== null) {
      this.resumeAt(held);
    } else if (this.uncertain) {
      this.seek(Math.max(0, this.sent.seq - this.transport.resendOverlap));
    }
    this.uncertain = false;
  }

  private resumeAt(held: ChainHead): void {
    if (held.seq > this.headSeq) {
      this.safeReport(
        `the destination holds seq ${held.seq}, past the log's last line ${this.headSeq}: the local tail was cut`,
      );
      return;
    }
    const found = this.seek(held.seq);
    if (held.seq > 0 && found !== null && found !== held.hash) {
      this.safeReport(`the destination's line at seq ${held.seq} differs from the log's`);
    }
  }

  private lost(reason: string): void {
    this.lastError = reason;
    if (this.closed) return;
    this.connected = false;
    this.uncertain = true;
    this.downSince ??= this.now();
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.closed || this.timer !== null) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.connect();
    }, this.retryMs);
    this.timer.unref?.();
    this.retryMs = Math.min(this.retryMs * 2, this.retry.maxMs);
  }

  private schedulePump(): void {
    if (this.pumping !== null) return;
    this.pumping = this.pump().finally(() => {
      this.pumping = null;
      if (this.connected && this.sent.seq < this.headSeq) this.schedulePump();
    });
  }

  /** Ships batches read from the local log until caught up or the destination is lost. */
  private async pump(): Promise<void> {
    while (this.connected && !this.closed && this.sent.seq < this.headSeq) {
      const read = readLinesFrom(this.opts.logPath, this.offset, this.batch);
      if (read.size < this.offset) {
        this.safeReport("the audit log shrank under the forwarder: its tail was cut");
        this.seekHead({ seq: this.sent.seq, hash: this.sent.hash });
        return;
      }
      const last = read.lines.at(-1);
      if (last === undefined) {
        this.offset = read.consumed;
        return;
      }
      try {
        await this.transport.write(read.lines.map((l) => l.line));
      } catch (cause) {
        this.lost(message(cause));
        return;
      }
      this.sent = { seq: last.line.seq, hash: last.line.hash };
      this.offset = last.end;
      this.saveCursor(false);
    }
    if (this.sent.seq >= this.headSeq) this.behindSince = null;
  }

  private saveCursor(clean: boolean): void {
    const { kind, target } = this.transport;
    const hash = this.sent.seq === 0 ? null : this.sent.hash;
    try {
      writeCursor(this.opts.cursorPath, { kind, target, seq: this.sent.seq, hash, clean });
    } catch (cause) {
      this.lastError = `cannot persist the forward cursor: ${message(cause)}`;
    }
  }

  private safeReport(problem: string): void {
    try {
      this.report(problem);
    } catch (cause) {
      this.lastError = `cannot audit a forwarder problem: ${message(cause)}`;
    }
  }
}
