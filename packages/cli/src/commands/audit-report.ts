/**
 * The report of `cops audit verify` (D-104): one JSON document (`jev-cops.audit-verify/1`)
 * built from the local verification and, with `--remote`, the comparison with the off-box
 * copy; and its rendering for a person.
 */
import type { AuditVerification, CopyComparison } from "@jev-cops/daemon";

/** `cops audit verify --json`. */
export interface AuditVerifyReport {
  readonly schema: "jev-cops.audit-verify/1";
  readonly ok: boolean;
  readonly local: {
    readonly path: string;
    readonly lines: number;
    readonly head_seq: number;
    readonly chain: { ok: boolean; broken_at: number | null; reason: string | null };
    readonly checkpoints: number;
    readonly signed_through: number;
    readonly unsigned_tail: { from: number; to: number; count: number } | null;
    readonly keys_in_force: readonly string[];
    readonly rotations: ReadonlyArray<{ seq: number; from: string; to: string }>;
  };
  readonly remote: {
    readonly path: string;
    readonly format: string;
    readonly lines: number;
    readonly head_seq: number;
    readonly duplicates: number;
    readonly lag: number;
    readonly truncated_after: number | null;
    readonly signed_past_local: boolean;
  } | null;
  readonly failures: readonly string[];
  readonly warnings: readonly string[];
}

function chainFailure(v: AuditVerification): string[] {
  if (v.chain.ok) return [];
  return [
    `chain broken at seq ${v.chain.brokenAt} (${v.chain.reason}): the log was edited or lines were deleted`,
  ];
}

/** The report from the local verification and the optional comparison. */
export function auditReport(
  path: string,
  v: AuditVerification,
  remote: { path: string; c: CopyComparison } | null,
): AuditVerifyReport {
  const failures = [...chainFailure(v), ...v.failures, ...(remote?.c.failures ?? [])];
  return {
    schema: "jev-cops.audit-verify/1",
    ok: failures.length === 0,
    local: {
      path,
      lines: v.lines,
      head_seq: v.headSeq,
      chain: {
        ok: v.chain.ok,
        broken_at: v.chain.brokenAt ?? null,
        reason: v.chain.reason ?? null,
      },
      checkpoints: v.checkpoints,
      signed_through: v.signedThrough,
      unsigned_tail: v.unsignedTail,
      keys_in_force: v.keysInForce,
      rotations: v.rotations,
    },
    remote:
      remote === null
        ? null
        : {
            path: remote.path,
            format: remote.c.remoteFormat,
            lines: remote.c.remoteLines,
            head_seq: remote.c.remoteHeadSeq,
            duplicates: remote.c.duplicates,
            lag: remote.c.lag,
            truncated_after: remote.c.truncatedAfter,
            signed_past_local: remote.c.signedPastLocal,
          },
    failures,
    warnings: [...v.warnings, ...(remote?.c.warnings ?? [])],
  };
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

function keyLine(r: AuditVerifyReport): string {
  const keys = r.local.keys_in_force;
  if (keys.length === 0) return "none verified";
  const rot = r.local.rotations.map((x) => `seq ${x.seq} ${x.from} → ${x.to}`);
  return rot.length === 0 ? (keys[0] ?? "") : `${keys[0]} (rotations: ${rot.join("; ")})`;
}

function remoteLine(r: AuditVerifyReport): string[] {
  const x = r.remote;
  if (x === null) return [];
  const dup = x.duplicates === 0 ? "" : `, ${plural(x.duplicates, "resent duplicate")} dropped`;
  return [
    `  off-box copy   ${x.path} (${x.format}): ${plural(x.lines, "line")}, last seq ${x.head_seq}${dup}`,
  ];
}

/** The report for a person. */
export function renderAuditReport(r: AuditVerifyReport): string[] {
  const l = r.local;
  const chain = l.chain.ok ? "ok" : `broken at seq ${l.chain.broken_at} (${l.chain.reason})`;
  const tail = l.unsigned_tail;
  const signed = `${l.checkpoints} verified, signed through seq ${l.signed_through}`;
  return [
    `cops audit verify ${l.path}`,
    `  lines          ${l.lines} (head seq ${l.head_seq})`,
    `  chain          ${chain}`,
    `  checkpoints    ${r.failures.length === 0 ? signed : `${l.checkpoints} found`}`,
    `  keys           ${keyLine(r)}`,
    `  unsigned tail  ${tail === null ? "none" : `seq ${tail.from}..${tail.to} (${plural(tail.count, "line")})`}`,
    ...remoteLine(r),
    ...r.failures.map((f) => `FAIL  ${f}`),
    ...r.warnings.map((w) => `warn  ${w}`),
    r.ok ? "result: verified" : `result: FAILED (${plural(r.failures.length, "failure")})`,
  ];
}
