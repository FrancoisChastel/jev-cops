/**
 * `cops doctor`, audit group (T12, D-103, D-104): the hash chain, the signed checkpoints
 * against the team's public key, the signing key copsd uses, the forwarder's state from
 * `/v1/health`, and with `--audit-remote` the local log against the off-box copy. The
 * same verifier as `cops audit verify`.
 */
import { existsSync, readFileSync } from "node:fs";
import {
  type AuditVerification,
  compareCopies,
  loadPublicKey,
  loadSigner,
  readRemoteCopy,
  verifyAuditLines,
} from "@jev-cops/daemon";
import { z } from "zod";
import { type Check, check } from "./doctor-types.ts";

const GROUP = "audit";
/** Forwarding lag past this is worth a warning (plan §6: lag > 0 for more than 60 s). */
const LAG_WARN_MS = 60_000;

/** What local verification guarantees now (replaces the M0 review's L6 caveat). */
export const AUDIT_GUARANTEE =
  "Signed checkpoints (Ed25519, private key outside the sandbox) make every line up to the last checkpoint impossible to edit, drop or recompute without that key; the lines after it, and a tail cut exactly at a checkpoint, show only against the off-box copy (--audit-remote).";

/** The `audit` block of copsd's `/v1/health`. */
export const auditHealthSchema = z.object({
  head_seq: z.number(),
  signing: z.object({
    key_id: z.string().nullable(),
    in_force: z.string().nullable(),
    checkpoint_every: z.number(),
    last_checkpoint_seq: z.number(),
    required: z.boolean(),
  }),
  forward: z
    .object({
      kind: z.string(),
      connected: z.boolean(),
      sent_seq: z.number(),
      lag_lines: z.number(),
      lag_ms: z.number(),
      last_error: z.string().nullable(),
      required: z.boolean(),
      refusing: z.boolean(),
    })
    .nullable(),
});
export type AuditHealth = z.infer<typeof auditHealthSchema>;

/** Everything the audit checks read. */
export interface AuditDoctorInput {
  readonly path: string;
  /** `[audit] key`. */
  readonly keyPath: string;
  /** `[audit] public_key`, or `--audit-pubkey`. */
  readonly publicKey: string;
  readonly requireSigning: boolean;
  /** `--audit-remote`: the team's off-box copy. */
  readonly remote: string | null;
  /** copsd's view; null when it did not answer. */
  readonly health: AuditHealth | null;
}

function texts(path: string): string[] {
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((t) => t !== "");
}

function chainCheck(path: string, v: AuditVerification | null): Check {
  if (v === null)
    return check(
      GROUP,
      "chain",
      "warn",
      `no audit log at ${path} (copsd not started with this config?)`,
    );
  if (!v.chain.ok) {
    const where = `broken at seq ${v.chain.brokenAt} of ${path} (${v.chain.reason})`;
    return check(
      GROUP,
      "chain",
      "fail",
      `${where}: the log was edited or lines were deleted (T12); keep the file for review`,
    );
  }
  const n = v.lines === 1 ? "1 line verifies" : `${v.lines} lines verify`;
  return check(GROUP, "chain", "ok", `${n} at ${path}`);
}

function signaturesCheck(i: AuditDoctorInput, all: readonly string[] | null): Check {
  const pub = loadPublicKey(i.publicKey);
  if (!pub.ok && pub.missing) {
    const d = `no public key at ${i.publicKey}: checkpoints are not verified (cops keygen writes it; hand it to the cyber team)`;
    return check(GROUP, "signatures", "warn", d);
  }
  if (!pub.ok) return check(GROUP, "signatures", "fail", pub.error);
  if (all === null) return check(GROUP, "signatures", "warn", "no audit log to verify");
  const v = verifyAuditLines(all, { keys: [pub.key] });
  if (!v.chain.ok) return check(GROUP, "signatures", "fail", "not verified: the chain is broken");
  if (v.failures.length > 0) return check(GROUP, "signatures", "fail", v.failures.join("; "));
  const tail =
    v.unsignedTail === null ? "" : `; ${v.unsignedTail.count} line(s) after it not signed yet`;
  const d = `${v.checkpoints} checkpoint(s) verify with key ${pub.key.keyId}, signed through seq ${v.signedThrough}${tail}. ${AUDIT_GUARANTEE}`;
  return check(GROUP, "signatures", "ok", d);
}

function keyCheck(i: AuditDoctorInput): Check {
  const loaded = loadSigner(i.keyPath);
  if (!loaded.ok && loaded.missing) {
    const d = `no signing key at ${i.keyPath}: copsd signs nothing (run cops keygen)`;
    return check(GROUP, "signing key", i.requireSigning ? "fail" : "warn", d);
  }
  if (!loaded.ok) return check(GROUP, "signing key", "fail", loaded.error);
  const id = loaded.signer.keyId;
  const running = i.health?.signing.key_id;
  if (running !== undefined && running !== id) {
    const now = running === null ? "unsigned" : `with key ${running}`;
    return check(
      GROUP,
      "signing key",
      "warn",
      `key ${id} at ${i.keyPath}, but copsd runs ${now}: restart copsd`,
    );
  }
  return check(GROUP, "signing key", "ok", `key ${id} at ${i.keyPath} (0600, outside any sandbox)`);
}

function forwardCheck(h: AuditHealth | null): Check {
  if (h === null)
    return check(GROUP, "forwarding", "warn", "copsd did not answer: forwarder state unknown");
  const f = h.forward;
  if (f === null) {
    const d =
      "the audit log is not shipped off-box ([audit.forward] unset): a tail cut at a checkpoint is invisible locally";
    return check(GROUP, "forwarding", "warn", d);
  }
  const state = `${f.kind}, ${f.connected ? "connected" : "disconnected"}, sent through seq ${f.sent_seq} of ${h.head_seq}`;
  const behind = `${f.lag_lines} line(s), ${Math.round(f.lag_ms / 1000)} s behind${f.last_error === null ? "" : ` (last error: ${f.last_error})`}`;
  if (f.refusing) {
    return check(
      GROUP,
      "forwarding",
      "fail",
      `${state}; ${behind}: forwarding is required, so copsd refuses deny-class calls`,
    );
  }
  if (f.lag_lines === 0 || (f.connected && f.lag_ms < LAG_WARN_MS)) {
    return check(GROUP, "forwarding", "ok", state);
  }
  return check(GROUP, "forwarding", "warn", `${state}; ${behind}`);
}

function remoteCheck(
  i: AuditDoctorInput,
  all: readonly string[],
  keys: ReturnType<typeof loadPublicKey>,
): Check {
  const remote = i.remote ?? "";
  let copy: ReturnType<typeof readRemoteCopy>;
  try {
    copy = readRemoteCopy(remote);
  } catch (cause) {
    return check(
      GROUP,
      "off-box copy",
      "fail",
      `cannot read ${remote}: ${(cause as Error).message}`,
    );
  }
  const c = compareCopies(all, copy, { keys: keys.ok ? [keys.key] : [] });
  const seen = `the receiver's last seq is ${c.remoteHeadSeq} (${copy.format})`;
  if (!c.ok) return check(GROUP, "off-box copy", "fail", `${c.failures.join("; ")}; ${seen}`);
  if (c.warnings.length > 0)
    return check(GROUP, "off-box copy", "warn", `${c.warnings.join("; ")}; ${seen}`);
  return check(
    GROUP,
    "off-box copy",
    "ok",
    `agrees with the local log; last seq ${c.remoteHeadSeq} (${copy.format})`,
  );
}

/** The audit checks, in report order. */
export function auditChecks(i: AuditDoctorInput): Check[] {
  const all = existsSync(i.path) ? texts(i.path) : null;
  const v = all === null ? null : verifyAuditLines(all, { keys: [] });
  const remote = i.remote === null ? [] : [remoteCheck(i, all ?? [], loadPublicKey(i.publicKey))];
  return [
    chainCheck(i.path, v),
    signaturesCheck(i, all),
    keyCheck(i),
    forwardCheck(i.health),
    ...remote,
  ];
}
