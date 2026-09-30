/**
 * Signed audit logs for tests (D-104): a log written by a real `AuditLog` with a fresh
 * Ed25519 key, and the tampering an agent without the key could try (edit, recompute,
 * re-sign with its own key, strip checkpoints, cut the tail).
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuditLog, auditTexts } from "../audit.ts";
import { type AuditLine, lineHash, lineText, parseLine } from "../audit-line.ts";
import { signCheckpoint } from "../audit-sign/checkpoint.ts";
import {
  type CheckpointSigner,
  generateAuditKey,
  type PublicKeyInfo,
  publicKeyFromPem,
  signerFromPem,
} from "../audit-sign/keys.ts";

/** A key pair ready for signing and verifying. */
export interface TestKey {
  readonly signer: CheckpointSigner;
  readonly pub: PublicKeyInfo;
  readonly publicPem: string;
  readonly privatePem: string;
}

/** A fresh Ed25519 key. */
export function testKey(): TestKey {
  const k = generateAuditKey();
  return {
    signer: signerFromPem(k.privatePem),
    pub: publicKeyFromPem(k.publicPem),
    publicPem: k.publicPem,
    privatePem: k.privatePem,
  };
}

/** Writes `lines` judge lines with `key` (checkpoint every `every`) and returns the texts. */
export function signedLog(key: TestKey | null, lines: number, every = 3): string[] {
  const dir = mkdtempSync(join(tmpdir(), "jev-cops-signed-"));
  try {
    const path = join(dir, "audit.jsonl");
    let at = 1_000;
    const signing = { signer: key?.signer ?? null, every };
    const log = AuditLog.open(path, { now: () => at++, signing });
    for (let i = 0; i < lines; i++) log.append({ kind: "judge", payload: { i } });
    log.close();
    return auditTexts(path);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function parsed(texts: readonly string[]): AuditLine[] {
  return texts.map((t) => {
    const line = parseLine(t);
    if (line === null) throw new Error(`not a line: ${t}`);
    return line;
  });
}

/** Rebuilds seq/prev/hash from the first line on, as a forger without the key can. */
export function rechain(lines: readonly AuditLine[]): string[] {
  let prev = lines[0]?.prev ?? "0".repeat(64);
  return lines.map((l, i) => {
    const { hash: _hash, ...rest } = l;
    const body = { ...rest, seq: i + 1, prev };
    const line = { ...body, hash: lineHash(body) };
    prev = line.hash;
    return lineText(line);
  });
}

/** `texts` with line `seq`'s payload replaced and the whole chain recomputed. */
export function recompute(texts: readonly string[], seq: number, payload: object): string[] {
  const lines = parsed(texts).map((l) => (l.seq === seq ? { ...l, payload: { ...payload } } : l));
  return rechain(lines);
}

/**
 * Like {@link recompute}, and every checkpoint re-signed by `forger` over the new chain
 * (the full recompute of an agent that made its own key).
 */
export function recomputeAndResign(
  texts: readonly string[],
  seq: number,
  payload: object,
  forger: CheckpointSigner,
): string[] {
  const out: AuditLine[] = [];
  let prevCp: { seq: number; hash: string } | null = null;
  for (const l of parsed(recompute(texts, seq, payload))) {
    const prev = out.at(-1);
    const body = { ...l, prev: prev?.hash ?? l.prev };
    const cp: AuditLine = body.kind === "checkpoint" ? resign(body, prev, prevCp, forger) : body;
    const { hash: _h, ...rest } = cp;
    const line: AuditLine = { ...rest, hash: lineHash(rest) };
    if (line.kind === "checkpoint") prevCp = { seq: line.seq, hash: line.hash };
    out.push(line);
  }
  return out.map(lineText);
}

function resign(
  l: AuditLine,
  prev: AuditLine | undefined,
  prevCp: { seq: number; hash: string } | null,
  forger: CheckpointSigner,
): AuditLine {
  const p = l.payload as Record<string, unknown>;
  const statement = {
    alg: "ed25519" as const,
    key_id: forger.keyId,
    head_seq: prev?.seq ?? 0,
    head_hash: prev?.hash ?? "",
    count: l.seq - 1 - (prevCp?.seq ?? 0),
    every: Number(p.every),
    prev_checkpoint: prevCp,
    reason: "interval" as const,
    at: l.at,
  };
  return { ...l, payload: signCheckpoint(statement, forger) };
}
