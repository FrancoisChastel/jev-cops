import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";
import type { ForwarderKind } from "./types.ts";

/**
 * The forward cursor (D-103): the last seq handed to one destination, persisted next to
 * the audit log (`[audit.forward] cursor`, a private path of the daemon) so a restart or
 * an outage resumes where shipping stopped. `clean` records a graceful close: without an
 * acknowledgement from syslog, lines written just before an abrupt stop may be lost, so an
 * unclean cursor makes the next connection resend an overlap (duplicates carry the same
 * seq and hash and verifiers drop them).
 */
export interface ForwardCursor {
  readonly kind: ForwarderKind;
  /** The destination (path or host:port); a cursor for another one is ignored. */
  readonly target: string;
  readonly seq: number;
  /** The hash of line `seq` when it was shipped; null at seq 0. */
  readonly hash: string | null;
  readonly clean: boolean;
}

const cursorSchema = z.strictObject({
  kind: z.enum(["file", "syslog"]),
  target: z.string(),
  seq: z.int().nonnegative(),
  hash: z.string().nullable(),
  clean: z.boolean(),
});

/** The cursor at `path` for this destination; null when absent, unreadable or another one's. */
export function readCursor(
  path: string,
  kind: ForwarderKind,
  target: string,
): ForwardCursor | null {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
  const parsed = cursorSchema.safeParse(raw);
  if (!parsed.success) return null;
  return parsed.data.kind === kind && parsed.data.target === target ? parsed.data : null;
}

/** Writes the cursor atomically (a temp file renamed over it), 0600 in a 0700 directory. */
export function writeCursor(path: string, cursor: ForwardCursor): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(cursor)}\n`, { mode: 0o600 });
  renameSync(tmp, path);
}
