import { verify } from "node:crypto";
import { canonicalJson, err, ok, type Result } from "@jev-cops/core";
import { z } from "zod";
import type { CheckpointSigner, PublicKeyInfo } from "./keys.ts";

/**
 * The payload of a `checkpoint` audit line (D-104): a statement about the chain signed
 * with Ed25519. The signed message is the domain line, a newline, then the canonical JSON
 * of every payload field but `sig`, so nothing in the statement can change unnoticed (the
 * reason and a rotation's next key included).
 */

/** The first line of every signed message; a signature is never valid for another use. */
export const CHECKPOINT_DOMAIN = "jev-cops.audit.checkpoint/1";

/** Why a checkpoint was written. */
export const CHECKPOINT_REASONS = [
  "interval",
  "session-end",
  "boot",
  "shutdown",
  "rotation",
] as const;
export type CheckpointReason = (typeof CHECKPOINT_REASONS)[number];

const hex64 = z.string().regex(/^[0-9a-f]{64}$/);
const keyId = z.string().regex(/^[0-9a-f]{16}$/);
const seq = z.int().nonnegative();

const checkpointSchema = z
  .strictObject({
    alg: z.literal("ed25519"),
    key_id: keyId,
    /** The line the checkpoint follows: its seq and hash (the checkpoint's own `prev`). */
    head_seq: seq,
    head_hash: hex64,
    /** Lines since the previous checkpoint line (excluded), through the head. */
    count: seq,
    /** The daemon's `[audit] checkpoint_every` when it signed. */
    every: z.int().positive(),
    /** The previous checkpoint line of the chain; null for the first. */
    prev_checkpoint: z.strictObject({ seq: z.int().positive(), hash: hex64 }).nullable(),
    reason: z.enum(CHECKPOINT_REASONS),
    /** The line's own `at`. */
    at: z.number(),
    next_key_id: keyId.optional(),
    next_public_key: z.string().min(1).optional(),
    sig: z.string().regex(/^[A-Za-z0-9_-]+$/),
  })
  .superRefine((c, ctx) => {
    const rotation = c.reason === "rotation";
    const hasNext = c.next_key_id !== undefined && c.next_public_key !== undefined;
    const anyNext = c.next_key_id !== undefined || c.next_public_key !== undefined;
    if (rotation && !hasNext) {
      ctx.addIssue({ code: "custom", message: "a rotation needs next_key_id and next_public_key" });
    }
    if (!rotation && anyNext) {
      ctx.addIssue({ code: "custom", message: "only a rotation names next_key_id" });
    }
  });

/** A validated, signed checkpoint payload. */
export type SignedCheckpoint = z.output<typeof checkpointSchema>;
/** A checkpoint payload before signing. */
export type UnsignedCheckpoint = Omit<SignedCheckpoint, "sig">;

/** The exact bytes signed for `c` (its `sig`, if any, left out). */
export function checkpointMessage(c: UnsignedCheckpoint | SignedCheckpoint): Buffer {
  const { sig: _sig, ...statement } = c as SignedCheckpoint;
  return Buffer.from(`${CHECKPOINT_DOMAIN}\n${canonicalJson(statement)}`, "utf8");
}

/** `c` with its signature by `signer`. */
export function signCheckpoint(c: UnsignedCheckpoint, signer: CheckpointSigner): SignedCheckpoint {
  return { ...c, sig: signer.sign(checkpointMessage(c)) };
}

/** True when `c.sig` is `key`'s signature of `c`. Never throws. */
export function verifyCheckpointSignature(c: SignedCheckpoint, key: PublicKeyInfo): boolean {
  try {
    return verify(null, checkpointMessage(c), key.key, Buffer.from(c.sig, "base64url"));
  } catch {
    return false;
  }
}

/** The payload of a checkpoint line, validated; the error names the first problem. */
export function parseCheckpoint(payload: unknown): Result<SignedCheckpoint, string> {
  const parsed = checkpointSchema.safeParse(payload);
  if (parsed.success) return ok(parsed.data);
  const issue = parsed.error.issues[0];
  const where = issue?.path.join(".") ?? "";
  return err(`${where === "" ? "" : `${where}: `}${issue?.message ?? "invalid checkpoint"}`);
}
