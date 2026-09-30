/**
 * The contract every audit forwarder passes (D-103), run against each destination: the
 * file copy and the syslog receiver of `syslog-receiver.ts`. A harness builds forwarders
 * with fast retries and can take its destination down and bring it back.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuditLog, readAudit } from "../audit.ts";
import { readCursor, writeCursor } from "../audit-forward/cursor.ts";
import type { ForwardTransport } from "../audit-forward/forwarder.ts";
import type { AuditForwarder, ForwarderKind } from "../audit-forward/types.ts";
import type { AuditLine } from "../audit-line.ts";

/** One destination under test. */
export interface ForwardHarness {
  readonly kind: ForwarderKind;
  readonly target: string;
  /** Most lines one outage may ship twice (0: exactly once). */
  readonly overlap: number;
  make(logPath: string, cursorPath: string): AuditForwarder;
  /** What the destination holds, one entry per seq, and how many lines arrived twice. */
  received(): Promise<{ lines: AuditLine[]; duplicates: number }>;
  /** Takes the destination down: open connections drop, new ones fail. */
  breakIt(): Promise<void>;
  restore(): Promise<void>;
  dispose(): Promise<void>;
}

/** One entry per seq (the first seen), and how many lines repeated a seq already seen. */
export function dedupeBySeq(lines: readonly AuditLine[]): {
  lines: AuditLine[];
  duplicates: number;
} {
  const bySeq = new Map<number, AuditLine>();
  for (const line of lines) if (!bySeq.has(line.seq)) bySeq.set(line.seq, line);
  const unique = [...bySeq.values()].sort((a, b) => a.seq - b.seq);
  return { lines: unique, duplicates: lines.length - unique.length };
}

/** A switch that makes a transport fail: connect and write throw while `broken`. */
export interface Fault {
  broken: boolean;
}

/** `inner`, failing on connect and write while `fault.broken` (an unreachable destination). */
export function faulty(inner: ForwardTransport, fault: Fault): ForwardTransport {
  const down = () => {
    if (fault.broken) throw new Error("destination unreachable (test fault)");
  };
  return {
    kind: inner.kind,
    target: inner.target,
    resendOverlap: inner.resendOverlap,
    connect: async () => {
      down();
      await inner.connect();
    },
    delivered: () => inner.delivered(),
    write: async (lines) => {
      down();
      await inner.write(lines);
    },
    onDrop: (cb) => inner.onDrop(cb),
    close: () => inner.close(),
  };
}

/** Polls `read` until `done` holds or `ms` pass; returns the last value read. */
export async function waitFor<T>(
  read: () => T | Promise<T>,
  done: (value: T) => boolean,
  ms = 5_000,
): Promise<T> {
  const deadline = performance.now() + ms;
  let value = await read();
  while (!done(value) && performance.now() < deadline) {
    await Bun.sleep(10);
    value = await read();
  }
  return value;
}

/** Registers the contract suite for the harness `setup` builds in a fresh temp directory. */
export function forwarderContract(name: string, setup: (dir: string) => Promise<ForwardHarness>) {
  describe(`${name} forwarder contract`, () => {
    let dir: string;
    let h: ForwardHarness;
    let logPath: string;
    let cursorPath: string;

    beforeEach(async () => {
      dir = mkdtempSync(join(tmpdir(), "jev-cops-fwd-"));
      logPath = join(dir, "audit.jsonl");
      cursorPath = join(dir, "forward.cursor");
      h = await setup(dir);
    });

    afterEach(async () => {
      await h.dispose();
      rmSync(dir, { recursive: true, force: true });
    });

    const local = () => readAudit(logPath).lines;
    const all = (n: number) => (r: { lines: AuditLine[] }) => r.lines.length >= n;

    function appendMany(log: AuditLog, n: number): void {
      for (let i = 0; i < n; i++) log.append({ kind: "judge", payload: { i } });
    }

    test("ships every line in order, each once", async () => {
      const fwd = h.make(logPath, cursorPath);
      const log = AuditLog.open(logPath, { forwarder: fwd });
      appendMany(log, 5);
      expect(await fwd.flush(5_000)).toBe(true);
      const got = await waitFor(() => h.received(), all(5));
      expect(got).toEqual({ lines: local(), duplicates: 0 });
      expect(fwd.status()).toMatchObject({ kind: h.kind, sentSeq: 5, lagLines: 0, lagMs: 0 });
      log.close();
      await fwd.close();
      expect(readCursor(cursorPath, h.kind, h.target)).toMatchObject({ seq: 5, clean: true });
    });

    test("a restart resumes from the cursor and ships nothing twice", async () => {
      const first = h.make(logPath, cursorPath);
      const log = AuditLog.open(logPath, { forwarder: first });
      appendMany(log, 3);
      await first.flush(5_000);
      log.close();
      await first.close();
      const second = h.make(logPath, cursorPath);
      const again = AuditLog.open(logPath, { forwarder: second });
      appendMany(again, 2);
      expect(await second.flush(5_000)).toBe(true);
      const got = await waitFor(() => h.received(), all(5));
      expect(got).toEqual({ lines: local(), duplicates: 0 });
      again.close();
      await second.close();
    });

    test("an outage is caught up from the local log; resends repeat the same lines only", async () => {
      const fwd = h.make(logPath, cursorPath);
      const log = AuditLog.open(logPath, { forwarder: fwd });
      appendMany(log, 2);
      await fwd.flush(5_000);
      await waitFor(() => h.received(), all(2));
      await h.breakIt();
      appendMany(log, 3);
      const down = await waitFor(
        () => fwd.status(),
        (s) => !s.connected,
      );
      expect(down).toMatchObject({ connected: false, headSeq: 5 });
      expect(down.lastError).not.toBeNull();
      expect(down.downSince).not.toBeNull();
      appendMany(log, 2);
      expect(fwd.status().lagLines).toBeGreaterThan(0);
      await h.restore();
      expect(await fwd.flush(5_000)).toBe(true);
      const got = await waitFor(() => h.received(), all(7));
      expect(got.lines).toEqual(local());
      expect(got.duplicates).toBeLessThanOrEqual(h.overlap);
      log.close();
      await fwd.close();
    });

    test("a cursor past the log's last line is an anomaly (the local tail was cut)", async () => {
      const seed = AuditLog.open(logPath);
      appendMany(seed, 3);
      seed.close();
      const cursor = { kind: h.kind, target: h.target, seq: 9, hash: "x", clean: true };
      writeCursor(cursorPath, cursor);
      const fwd = h.make(logPath, cursorPath);
      const log = AuditLog.open(logPath, { forwarder: fwd });
      log.close();
      await fwd.close();
      const anomaly = local().find((l) => l.kind === "anomaly");
      expect(String(anomaly?.payload.reason)).toContain("past the log's last line");
    });

    test("a line changed under the cursor is an anomaly (the log was rewritten)", async () => {
      const seed = AuditLog.open(logPath);
      appendMany(seed, 3);
      seed.close();
      writeCursor(cursorPath, { kind: h.kind, target: h.target, seq: 2, hash: "x", clean: true });
      const fwd = h.make(logPath, cursorPath);
      const log = AuditLog.open(logPath, { forwarder: fwd });
      log.close();
      await fwd.close();
      const anomaly = local().find((l) => l.kind === "anomaly");
      expect(String(anomaly?.payload.reason)).toContain("differs from the line shipped");
    });
  });
}
