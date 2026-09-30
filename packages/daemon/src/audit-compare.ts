import type { RemoteCopy } from "./audit-forward/syslog-parse.ts";
import { type AuditLine, hashMatches, lineText, parseLine } from "./audit-line.ts";
import { type VerifyOptions, verifyAuditLines } from "./audit-verify.ts";

/**
 * The local log against the off-box copy (D-104, T12). Both must hold the same line at
 * every seq they share. A copy longer than the local log is a local truncation — the copy
 * can only have received what copsd wrote locally first — and fails whether or not a
 * signed checkpoint covers the missing lines (the report says which). A local log longer
 * than the copy is forwarding lag, a warning.
 */
export interface CopyComparison {
  readonly ok: boolean;
  readonly remoteFormat: RemoteCopy["format"];
  readonly remoteLines: number;
  readonly remoteHeadSeq: number;
  readonly duplicates: number;
  /** The local head seq when the copy goes further; null otherwise. */
  readonly truncatedAfter: number | null;
  /** True when the copy's lines past the local head carry a checkpoint that verifies. */
  readonly signedPastLocal: boolean;
  /** Local lines the copy does not have yet. */
  readonly lag: number;
  readonly failures: readonly string[];
  readonly warnings: readonly string[];
}

function ranges(seqs: readonly number[]): string[] {
  const out: string[] = [];
  let start: number | null = null;
  let prev = 0;
  for (const s of [...seqs, Number.NaN]) {
    if (start !== null && s === prev + 1) {
      prev = s;
      continue;
    }
    if (start !== null) out.push(start === prev ? `${start}` : `${start}..${prev}`);
    start = s;
    prev = s;
  }
  return out;
}

/** Seqs between the copy's first and last line that it does not hold. */
function gaps(remote: readonly AuditLine[]): number[] {
  const held = new Set(remote.map((l) => l.seq));
  const first = remote[0]?.seq ?? 0;
  const last = remote.at(-1)?.seq ?? 0;
  const missing: number[] = [];
  for (let s = first; s <= last; s++) if (!held.has(s)) missing.push(s);
  return missing;
}

/** Seqs both hold with different lines, or a copy line whose hash does not recompute. */
function disagreements(local: ReadonlyMap<number, AuditLine>, remote: readonly AuditLine[]) {
  const out: string[] = [];
  for (const r of remote) {
    if (!hashMatches(r)) out.push(`off-box copy: seq ${r.seq} does not hash to its hash`);
    const l = local.get(r.seq);
    if (l !== undefined && l.hash !== r.hash) {
      out.push(`the local log and the off-box copy differ at seq ${r.seq}`);
    }
  }
  return out;
}

/** The failure for a copy that goes past the local head, and whether a signature covers it. */
function pastLocal(
  localTexts: readonly string[],
  extension: readonly AuditLine[],
  opts: VerifyOptions,
) {
  const local = verifyAuditLines(localTexts, { keys: [] });
  const merged = verifyAuditLines([...localTexts, ...extension.map(lineText)], opts);
  const head = local.headSeq;
  const last = extension.at(-1)?.seq ?? head;
  if (!merged.chain.ok) {
    return {
      signed: false,
      failure: `the off-box copy diverges after seq ${head}: its seq ${head + 1}.. does not continue the local chain`,
    };
  }
  const signed =
    opts.keys.length > 0 && merged.failures.length === 0 && merged.signedThrough >= head;
  const cover = signed ? " under a signed checkpoint" : " (no signed checkpoint covers them)";
  return {
    signed,
    failure: `local tail truncated after seq ${head}: the off-box copy continues to seq ${last}${cover}`,
  };
}

/** Compares the local log's lines with the off-box copy. */
export function compareCopies(
  localTexts: readonly string[],
  remote: RemoteCopy,
  opts: VerifyOptions,
): CopyComparison {
  const localLines = localTexts.map((t) => parseLine(t)).filter((l) => l !== null);
  const local = new Map(localLines.map((l) => [l.seq, l]));
  const localHead = localLines.at(-1)?.seq ?? 0;
  const remoteHead = remote.lines.at(-1)?.seq ?? 0;
  const failures = [
    ...remote.problems.map((p) => `off-box copy: ${p}`),
    ...disagreements(local, remote.lines),
  ];
  const extension = remote.lines.filter((l) => l.seq > localHead);
  const past = extension.length > 0 ? pastLocal(localTexts, extension, opts) : null;
  if (past !== null) failures.push(past.failure);
  const missing = ranges(gaps(remote.lines));
  const lag = Math.max(0, localHead - remoteHead);
  const warnings = [
    ...(missing.length > 0 ? [`the off-box copy misses seq ${missing.join(", ")}`] : []),
    ...(lag > 0
      ? [`forwarding lag: ${lag} local lines not in the off-box copy (its last seq ${remoteHead})`]
      : []),
  ];
  return {
    ok: failures.length === 0,
    remoteFormat: remote.format,
    remoteLines: remote.lines.length,
    remoteHeadSeq: remoteHead,
    duplicates: remote.duplicates,
    truncatedAfter: past === null ? null : localHead,
    signedPastLocal: past?.signed ?? false,
    lag,
    failures,
    warnings,
  };
}
