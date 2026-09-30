import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuditLog, readAudit, verifyChain } from "./audit.ts";
import type { AuditForwarder, ForwarderStatus } from "./audit-forward/types.ts";
import type { AuditLine, ChainHead } from "./audit-line.ts";
import { parseCheckpoint, verifyCheckpointSignature } from "./audit-sign/checkpoint.ts";
import { generateAuditKey, publicKeyFromPem, signerFromPem } from "./audit-sign/keys.ts";

let dir: string;
let path: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "jev-cops-cp-"));
  path = join(dir, "audit.jsonl");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const key = generateAuditKey();
const signer = signerFromPem(key.privatePem);
const pub = publicKeyFromPem(key.publicPem);

function open(every = 3, s: typeof signer | null = signer, forwarder?: AuditForwarder): AuditLog {
  let at = 1_000;
  return AuditLog.open(path, {
    now: () => at++,
    signing: { signer: s, every },
    ...(forwarder === undefined ? {} : { forwarder }),
  });
}

function checkpoints(): AuditLine[] {
  return readAudit(path).lines.filter((l) => l.kind === "checkpoint");
}

function payloadOf(line: AuditLine | undefined) {
  const parsed = parseCheckpoint(line?.payload);
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.value;
}

describe("checkpoint cadence", () => {
  test("every N lines a signed checkpoint follows, linked to the previous one", () => {
    const log = open(3);
    for (let i = 0; i < 7; i++) log.append({ kind: "judge", payload: { i } });
    log.close();
    const cps = checkpoints();
    expect(cps.map((c) => c.seq)).toEqual([4, 8]);
    const [first, second] = cps.map(payloadOf);
    expect(first).toMatchObject({ head_seq: 3, count: 3, every: 3, reason: "interval" });
    expect(first?.prev_checkpoint).toBeNull();
    expect(first?.head_hash).toBe(cps[0]?.prev ?? "");
    expect(first?.at).toBe(cps[0]?.at ?? 0);
    expect(second).toMatchObject({ head_seq: 7, count: 3 });
    expect(second?.prev_checkpoint).toEqual({ seq: 4, hash: cps[0]?.hash ?? "" });
    for (const p of [first, second]) {
      if (p === undefined) throw new Error("missing");
      expect(verifyCheckpointSignature(p, pub)).toBe(true);
    }
    expect(verifyChain(path).ok).toBe(true);
  });

  test("an explicit checkpoint covers the lines since the last one; none when nothing is new", () => {
    const log = open(100);
    log.append({ kind: "session", payload: {} });
    const cp = log.checkpoint("session-end");
    expect(payloadOf(cp ?? undefined)).toMatchObject({ reason: "session-end", count: 1 });
    expect(log.checkpoint("shutdown")).toBeNull();
    log.close();
  });

  test("without a key nothing is signed", () => {
    const log = open(2, null);
    for (let i = 0; i < 5; i++) log.append({ kind: "judge", payload: {} });
    expect(log.checkpoint("shutdown")).toBeNull();
    expect(log.signing()).toEqual({ keyId: null, every: 2, lastCheckpointSeq: 0, inForce: null });
    log.close();
    expect(checkpoints()).toEqual([]);
  });

  test("reopening continues from the last checkpoint in the file", () => {
    const first = open(3);
    for (let i = 0; i < 4; i++) first.append({ kind: "judge", payload: {} });
    first.close();
    const again = open(3);
    expect(again.signing()).toMatchObject({ lastCheckpointSeq: 4, inForce: key.keyId });
    again.append({ kind: "judge", payload: {} });
    again.append({ kind: "judge", payload: {} });
    again.close();
    const cps = checkpoints();
    expect(cps.map((c) => c.seq)).toEqual([4, 8]);
    expect(payloadOf(cps[1])).toMatchObject({ count: 3, prev_checkpoint: { seq: 4 } });
  });
});

describe("rotation", () => {
  test("a rotation line signed by the old key names the new one, which signs from then on", () => {
    const next = signerFromPem(generateAuditKey().privatePem);
    const log = open(2);
    log.append({ kind: "judge", payload: {} });
    const rot = log.rotate(next);
    log.append({ kind: "judge", payload: {} });
    log.append({ kind: "judge", payload: {} });
    log.close();
    const r = payloadOf(rot);
    expect(r).toMatchObject({ reason: "rotation", key_id: key.keyId, next_key_id: next.keyId });
    expect(r.next_public_key).toBe(next.publicKeyPem);
    expect(verifyCheckpointSignature(r, pub)).toBe(true);
    const last = payloadOf(checkpoints().at(-1));
    expect(last.key_id).toBe(next.keyId);
    expect(verifyCheckpointSignature(last, publicKeyFromPem(next.publicKeyPem))).toBe(true);
  });

  test("rotating without a current key is refused", () => {
    const log = open(2, null);
    expect(() => log.rotate(signer)).toThrow(/no current key/);
    log.close();
  });
});

describe("forwarding hook", () => {
  test("the forwarder is opened at the head, gets every line, and its notes are audited", () => {
    const sent: AuditLine[] = [];
    const heads: ChainHead[] = [];
    const fwd: AuditForwarder = {
      open: (head, report) => {
        heads.push(head);
        report("cursor ahead of the log");
      },
      send: (l) => {
        sent.push(l);
      },
      status: () => ({}) as ForwarderStatus,
      flush: async () => true,
      close: async () => {},
    };
    const log = open(2, signer, fwd);
    log.append({ kind: "judge", payload: {} });
    log.close();
    expect(heads).toEqual([{ seq: 0, hash: "0".repeat(64) }]);
    expect(sent.map((l) => l.kind)).toEqual(["anomaly", "judge", "checkpoint"]);
    expect(sent[0]?.payload).toEqual({ reason: "cursor ahead of the log", source: "forwarder" });
  });

  test("a forwarder that throws never breaks an append", () => {
    const fwd: AuditForwarder = {
      open: () => {},
      send: () => {
        throw new Error("boom");
      },
      status: () => ({}) as ForwarderStatus,
      flush: async () => true,
      close: async () => {},
    };
    const log = open(100, null, fwd);
    expect(log.append({ kind: "judge", payload: {} }).seq).toBe(1);
    log.close();
  });
});
