import { closeSync, fsyncSync, mkdirSync, openSync, writeSync } from "node:fs";
import { dirname } from "node:path";
import type { AuditLine, ChainHead } from "../audit-line.ts";
import { lineText } from "../audit-line.ts";
import { findLastLine } from "../audit-read.ts";
import type { ForwardTransport } from "./forwarder.ts";

/**
 * The `file` forwarder's destination (the M0 `[audit.forward] kind = "file"`): a JSONL
 * copy with byte-identical lines, typically on another mount. The copy is its own
 * acknowledgement: after a restart shipping resumes right after the copy's last line, so
 * no line is written twice.
 */
export class FileTransport implements ForwardTransport {
  readonly kind = "file";
  readonly resendOverlap = 0;
  private fd: number | null = null;

  constructor(readonly target: string) {}

  async connect(): Promise<void> {
    mkdirSync(dirname(this.target), { recursive: true, mode: 0o700 });
    this.fd = openSync(this.target, "a", 0o600);
  }

  delivered(): ChainHead {
    const last = findLastLine(this.target, () => true)?.line ?? null;
    return last === null ? { seq: 0, hash: "" } : { seq: last.seq, hash: last.hash };
  }

  async write(lines: readonly AuditLine[]): Promise<void> {
    if (this.fd === null) throw new Error(`${this.target} is not open`);
    writeSync(this.fd, lines.map((l) => `${lineText(l)}\n`).join(""));
  }

  onDrop(): void {
    // A local file never drops on its own; a failed write is reported by write().
  }

  async close(): Promise<boolean> {
    const fd = this.fd;
    this.fd = null;
    if (fd === null) return false;
    fsyncSync(fd);
    closeSync(fd);
    return true;
  }
}
