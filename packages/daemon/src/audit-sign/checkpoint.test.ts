import { describe, expect, test } from "bun:test";
import {
  CHECKPOINT_DOMAIN,
  checkpointMessage,
  parseCheckpoint,
  signCheckpoint,
  type UnsignedCheckpoint,
  verifyCheckpointSignature,
} from "./checkpoint.ts";
import { generateAuditKey, publicKeyFromPem, signerFromPem } from "./keys.ts";

const key = generateAuditKey();
const signer = signerFromPem(key.privatePem);

function unsigned(over: Partial<UnsignedCheckpoint> = {}): UnsignedCheckpoint {
  return {
    alg: "ed25519",
    key_id: key.keyId,
    head_seq: 100,
    head_hash: "a".repeat(64),
    count: 100,
    every: 100,
    prev_checkpoint: null,
    reason: "interval",
    at: 1_000,
    ...over,
  };
}

describe("checkpoint statements", () => {
  test("the signed message is the domain line plus the canonical statement without sig", () => {
    const text = checkpointMessage(unsigned()).toString("utf8");
    expect(text.startsWith(`${CHECKPOINT_DOMAIN}\n{`)).toBe(true);
    expect(text).toContain('"head_seq":100');
    expect(text).not.toContain('"sig"');
  });

  test("a signature verifies with the key and fails on any changed field", () => {
    const signed = signCheckpoint(unsigned(), signer);
    const pub = publicKeyFromPem(key.publicPem);
    expect(verifyCheckpointSignature(signed, pub)).toBe(true);
    expect(verifyCheckpointSignature({ ...signed, head_seq: 101 }, pub)).toBe(false);
    expect(verifyCheckpointSignature({ ...signed, reason: "boot" }, pub)).toBe(false);
    expect(verifyCheckpointSignature({ ...signed, sig: "AAAA" }, pub)).toBe(false);
    const other = publicKeyFromPem(generateAuditKey().publicPem);
    expect(verifyCheckpointSignature(signed, other)).toBe(false);
  });

  test("rotation fields are covered by the signature", () => {
    const next = generateAuditKey();
    const rot = unsigned({
      reason: "rotation",
      next_key_id: next.keyId,
      next_public_key: next.publicPem,
    });
    const signed = signCheckpoint(rot, signer);
    const pub = publicKeyFromPem(key.publicPem);
    expect(verifyCheckpointSignature(signed, pub)).toBe(true);
    const swapped = { ...signed, next_public_key: generateAuditKey().publicPem };
    expect(verifyCheckpointSignature(swapped, pub)).toBe(false);
  });

  test("parseCheckpoint accepts a signed payload and names what is wrong otherwise", () => {
    const signed = signCheckpoint(unsigned(), signer);
    expect(parseCheckpoint(signed)).toEqual({ ok: true, value: signed });
    const parsed = parseCheckpoint({ ...signed, alg: "rsa" });
    expect(parsed.ok).toBe(false);
    expect(parseCheckpoint({ ...signed, reason: "rotation" })).toMatchObject({
      ok: false,
      error: expect.stringMatching(/next_key_id/),
    });
  });
});
