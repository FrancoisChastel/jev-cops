import { auditTexts, type ChainReport, checkLine } from "./audit.ts";
import { AUDIT_GENESIS, type AuditLine, parseLine } from "./audit-line.ts";
import {
  parseCheckpoint,
  type SignedCheckpoint,
  verifyCheckpointSignature,
} from "./audit-sign/checkpoint.ts";
import { type PublicKeyInfo, publicKeyFromPem } from "./audit-sign/keys.ts";

/**
 * Verifying an audit log without the daemon (D-104): the hash chain, then every
 * `checkpoint` line — its statement matches the chain, its signature verifies with the key
 * in force (a trusted root key, then the keys rotations name), and the lines after the
 * last checkpoint are no more than its interval. Without the private key nobody can
 * rewrite a line up to the last checkpoint, recompute the whole log or strip the
 * checkpoints without this failing. A tail cut exactly at a checkpoint still verifies:
 * that is what the off-box copy is compared for (`compareCopies`).
 */

/** What to verify signatures with; no key: the chain and the statements only. */
export interface VerifyOptions {
  readonly keys: readonly PublicKeyInfo[];
}

/** The outcome of {@link verifyAuditLines}. */
export interface AuditVerification {
  readonly ok: boolean;
  readonly lines: number;
  readonly headSeq: number;
  readonly headHash: string;
  readonly chain: ChainReport;
  readonly checkpoints: number;
  /** The head seq of the last checkpoint that verified with everything before it; 0 when none. */
  readonly signedThrough: number;
  /** Lines after the last checkpoint line (not covered by a signature yet). */
  readonly unsignedTail: {
    readonly from: number;
    readonly to: number;
    readonly count: number;
  } | null;
  /** The keys in force, in order (the root, then each rotation's). */
  readonly keysInForce: readonly string[];
  readonly rotations: ReadonlyArray<{
    readonly seq: number;
    readonly from: string;
    readonly to: string;
  }>;
  readonly failures: readonly string[];
  readonly warnings: readonly string[];
}

interface State {
  readonly trusted: Map<string, PublicKeyInfo>;
  readonly checking: boolean;
  inForce: string | null;
  keysInForce: string[];
  rotations: { seq: number; from: string; to: string }[];
  last: { seq: number; hash: string; every: number } | null;
  checkpoints: number;
  signedThrough: number;
  failures: string[];
}

/** Why the statement does not describe the chain at this line, or null. */
function statementProblem(line: AuditLine, c: SignedCheckpoint, st: State): string | null {
  if (c.head_seq !== line.seq - 1 || c.head_hash !== line.prev) {
    return "head_seq/head_hash do not name the line it follows (the chain was rewritten)";
  }
  if (c.at !== line.at) return "its signed time differs from the line's";
  const prev = st.last === null ? null : { seq: st.last.seq, hash: st.last.hash };
  if (JSON.stringify(c.prev_checkpoint) !== JSON.stringify(prev)) {
    return "prev_checkpoint does not name the previous checkpoint (one was removed or forged)";
  }
  const expected = line.seq - 1 - (st.last?.seq ?? 0);
  return c.count === expected ? null : `count ${c.count} where ${expected} lines precede it`;
}

/** Why the signature does not hold under the key in force, or null; follows a rotation. */
function signatureProblem(line: AuditLine, c: SignedCheckpoint, st: State): string | null {
  if (st.inForce !== null && c.key_id !== st.inForce) {
    return `signed by key ${c.key_id} while ${st.inForce} is in force (a key change without a rotation line)`;
  }
  const key = st.trusted.get(c.key_id);
  if (key === undefined) return `signed by key ${c.key_id}, which is not trusted (--pubkey)`;
  if (!verifyCheckpointSignature(c, key)) return `bad signature (key ${c.key_id})`;
  if (st.inForce === null) st.keysInForce.push(c.key_id);
  st.inForce = c.key_id;
  if (c.reason !== "rotation" || c.next_public_key === undefined) return null;
  let next: PublicKeyInfo;
  try {
    next = publicKeyFromPem(c.next_public_key);
  } catch {
    return "the rotation's next_public_key is not an Ed25519 public key";
  }
  if (next.keyId !== c.next_key_id) return "the rotation's next_key_id does not match its key";
  st.trusted.set(next.keyId, next);
  st.rotations.push({ seq: line.seq, from: c.key_id, to: next.keyId });
  st.keysInForce.push(next.keyId);
  st.inForce = next.keyId;
  return null;
}

function onCheckpoint(line: AuditLine, st: State): void {
  st.checkpoints += 1;
  const parsed = parseCheckpoint(line.payload);
  const c = parsed.ok ? parsed.value : null;
  const problem =
    c === null
      ? `malformed: ${parsed.ok ? "" : parsed.error}`
      : (statementProblem(line, c, st) ?? (st.checking ? signatureProblem(line, c, st) : null));
  if (problem !== null) st.failures.push(`checkpoint seq ${line.seq}: ${problem}`);
  else if (st.failures.length === 0 && c !== null) st.signedThrough = c.head_seq;
  st.last = { seq: line.seq, hash: line.hash, every: c?.every ?? Number.POSITIVE_INFINITY };
}

/** Walks the chain; stops at the first break. */
function walk(texts: readonly string[], st: State) {
  let head = { seq: 0, hash: AUDIT_GENESIS };
  for (const text of texts) {
    const problem = checkLine(text, head.seq, head.hash);
    if (problem !== null) {
      const brokenAt = parseLine(text)?.seq ?? head.seq + 1;
      return { head, chain: { ok: false, lines: texts.length, brokenAt, reason: problem } };
    }
    const line = parseLine(text) as AuditLine;
    if (line.kind === "checkpoint") onCheckpoint(line, st);
    head = { seq: line.seq, hash: line.hash };
  }
  return { head, chain: { ok: true, lines: texts.length } };
}

/** The failure or warning about the lines after the last checkpoint. */
function tailFindings(headSeq: number, st: State): { failures: string[]; warnings: string[] } {
  if (!st.checking) return { failures: [], warnings: ["signatures not verified (no public key)"] };
  if (st.last === null) {
    const none = `no signed checkpoint in ${headSeq} lines: the log cannot be authenticated`;
    return headSeq === 0 ? { failures: [], warnings: [] } : { failures: [none], warnings: [] };
  }
  const count = headSeq - st.last.seq;
  if (count === 0) return { failures: [], warnings: [] };
  const range = `seq ${st.last.seq + 1}..${headSeq}`;
  if (count > st.last.every) {
    const why = `${count} lines after the last checkpoint (${range}), more than its interval of ${st.last.every}: lines were appended without the key`;
    return { failures: [why], warnings: [] };
  }
  const note = `unsigned tail: ${range} (${count} lines) after the last checkpoint; a cut there shows only against the off-box copy`;
  return { failures: [], warnings: [note] };
}

/** Verifies the lines of an audit log (the texts, in file order). */
export function verifyAuditLines(texts: readonly string[], opts: VerifyOptions): AuditVerification {
  const st: State = {
    trusted: new Map(opts.keys.map((k) => [k.keyId, k])),
    checking: opts.keys.length > 0,
    inForce: null,
    keysInForce: [],
    rotations: [],
    last: null,
    checkpoints: 0,
    signedThrough: 0,
    failures: [],
  };
  const { head, chain } = walk(texts, st);
  const tail = chain.ok ? tailFindings(head.seq, st) : { failures: [], warnings: [] };
  const failures = [...st.failures, ...tail.failures];
  const tailCount = head.seq - (st.last?.seq ?? 0);
  return {
    ok: chain.ok && failures.length === 0,
    lines: texts.length,
    headSeq: head.seq,
    headHash: head.hash,
    chain,
    checkpoints: st.checkpoints,
    signedThrough: st.signedThrough,
    unsignedTail:
      tailCount > 0 ? { from: head.seq - tailCount + 1, to: head.seq, count: tailCount } : null,
    keysInForce: st.keysInForce,
    rotations: st.rotations,
    failures,
    warnings: tail.warnings,
  };
}

/** {@link verifyAuditLines} over the file at `path` (missing: an empty log). */
export function verifyAuditFile(path: string, opts: VerifyOptions): AuditVerification {
  return verifyAuditLines(auditTexts(path), opts);
}
