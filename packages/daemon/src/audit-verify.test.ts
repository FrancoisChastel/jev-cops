import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuditLog, auditTexts } from "./audit.ts";
import { lineText, parseLine } from "./audit-line.ts";
import { signCheckpoint, type UnsignedCheckpoint } from "./audit-sign/checkpoint.ts";
import { verifyAuditLines } from "./audit-verify.ts";
import { recompute, recomputeAndResign, signedLog, testKey } from "./testing/signed-log.ts";

const key = testKey();

describe("verifyAuditLines: chain and signatures (D-104)", () => {
  test("an intact signed log verifies; the lines after the last checkpoint are reported", () => {
    const texts = signedLog(key, 7, 3);
    const v = verifyAuditLines(texts, { keys: [key.pub] });
    expect(v).toMatchObject({
      ok: true,
      lines: 9,
      headSeq: 9,
      checkpoints: 2,
      signedThrough: 7,
      unsignedTail: { from: 9, to: 9, count: 1 },
      keysInForce: [key.pub.keyId],
      failures: [],
    });
    expect(v.warnings.join(" ")).toContain("unsigned tail");
  });

  test("without a public key the chain is checked and the signatures are not", () => {
    const v = verifyAuditLines(signedLog(key, 4, 3), { keys: [] });
    expect(v.ok).toBe(true);
    expect(v.warnings.join(" ")).toContain("signatures not verified");
  });

  test("an edited line breaks the chain", () => {
    const texts = signedLog(key, 5, 3);
    texts[1] = (texts[1] ?? "").replace('"i":1', '"i":9');
    expect(verifyAuditLines(texts, { keys: [key.pub] })).toMatchObject({
      ok: false,
      chain: { ok: false, brokenAt: 2 },
    });
  });

  test("a full recompute without the key fails at the first checkpoint after the rewrite", () => {
    const v = verifyAuditLines(recompute(signedLog(key, 7, 3), 2, { i: 42 }), { keys: [key.pub] });
    expect(v.chain.ok).toBe(true);
    expect(v.ok).toBe(false);
    expect(v.failures[0]).toContain("checkpoint seq 4");
    expect(v.failures[0]).toContain("head_hash");
  });

  test("a full recompute re-signed with another key fails: that key is not trusted", () => {
    const forger = testKey();
    const texts = recomputeAndResign(signedLog(key, 7, 3), 2, { i: 42 }, forger.signer);
    const v = verifyAuditLines(texts, { keys: [key.pub] });
    expect(v.ok).toBe(false);
    expect(v.failures[0]).toContain(`key ${forger.pub.keyId}`);
    expect(v.failures[0]).toContain("not trusted");
    expect(verifyAuditLines(texts, { keys: [forger.pub] }).ok).toBe(true);
  });

  test("a recompute that strips every checkpoint is not authenticated", () => {
    const lines = signedLog(key, 7, 3)
      .map((t) => parseLine(t))
      .filter((l) => l !== null && l.kind !== "checkpoint");
    const stripped = recompute(
      lines.map((l) => lineText(l as NonNullable<typeof l>)),
      1,
      { i: 0 },
    );
    const v = verifyAuditLines(stripped, { keys: [key.pub] });
    expect(v.ok).toBe(false);
    expect(v.failures[0]).toContain("no signed checkpoint");
  });

  test("more unsigned lines than the interval after the last checkpoint fail", () => {
    const texts = signedLog(key, 3, 3);
    const more = recompute([...texts, ...signedLog(null, 5, 3)], 1, { i: 0 });
    const v = verifyAuditLines(more, { keys: [key.pub] });
    expect(v.ok).toBe(false);
    expect(v.failures.join(" ")).toMatch(/after the last checkpoint/);
  });

  test("a wrong public key fails every checkpoint", () => {
    const v = verifyAuditLines(signedLog(key, 4, 3), { keys: [testKey().pub] });
    expect(v.ok).toBe(false);
    expect(v.failures[0]).toContain("not trusted");
  });

  test("a bad signature under the trusted key id fails", () => {
    const texts = signedLog(key, 4, 3);
    const cp = parseLine(texts[3] ?? "");
    const payload = { ...(cp?.payload as Record<string, unknown>), sig: "AAAA" };
    const forged = recompute(texts, 4, payload);
    expect(verifyAuditLines(forged, { keys: [key.pub] }).failures[0]).toContain("bad signature");
  });
});

describe("rotation", () => {
  function rotated(every: number) {
    const next = testKey();
    const dir = mkdtempSync(join(tmpdir(), "jv-rot-"));
    const path = join(dir, "a.jsonl");
    let at = 1;
    const log = AuditLog.open(path, { now: () => at++, signing: { signer: key.signer, every } });
    log.append({ kind: "judge", payload: {} });
    log.rotate(next.signer);
    for (let i = 0; i < 4; i++) log.append({ kind: "judge", payload: { i } });
    log.close();
    const texts = auditTexts(path);
    rmSync(dir, { recursive: true, force: true });
    return { texts, next };
  }

  test("the verifier follows a rotation signed by the old key to the new key", () => {
    const { texts, next } = rotated(2);
    const v = verifyAuditLines(texts, { keys: [key.pub] });
    expect(v.ok).toBe(true);
    expect(v.keysInForce).toEqual([key.pub.keyId, next.pub.keyId]);
    expect(v.rotations).toEqual([{ seq: 2, from: key.pub.keyId, to: next.pub.keyId }]);
  });

  test("the old key signing after the rotation fails", () => {
    const { texts } = rotated(2);
    const lines = texts.map((t) => parseLine(t));
    const last = lines.findLastIndex((l) => l?.kind === "checkpoint");
    const forged = recomputeWithOldKey(texts, last);
    const v = verifyAuditLines(forged, { keys: [key.pub] });
    expect(v.ok).toBe(false);
  });
});

/** Re-signs checkpoint line `index` with the original (rotated-out) key. */
function recomputeWithOldKey(texts: readonly string[], index: number): string[] {
  const line = parseLine(texts[index] ?? "");
  const p: Record<string, unknown> = { ...line?.payload, key_id: key.pub.keyId };
  const { sig: _sig, ...statement } = p;
  const signed = signCheckpoint(statement as UnsignedCheckpoint, key.signer);
  return recompute(texts, line?.seq ?? 0, signed);
}
