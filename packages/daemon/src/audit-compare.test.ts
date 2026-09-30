import { describe, expect, test } from "bun:test";
import { compareCopies } from "./audit-compare.ts";
import type { RemoteCopy } from "./audit-forward/syslog-parse.ts";
import { parseLine } from "./audit-line.ts";
import { recompute, signedLog, testKey } from "./testing/signed-log.ts";

const key = testKey();

function remoteOf(texts: readonly string[], over: Partial<RemoteCopy> = {}): RemoteCopy {
  const lines = texts.map((t) => parseLine(t)).filter((l) => l !== null);
  return { format: "jsonl", lines, problems: [], duplicates: 0, ...over };
}

describe("compareCopies: the local log against the off-box copy (D-104, T12)", () => {
  test("identical copies agree", () => {
    const texts = signedLog(key, 5, 3);
    expect(compareCopies(texts, remoteOf(texts), { keys: [key.pub] })).toMatchObject({
      ok: true,
      remoteHeadSeq: 6,
      truncatedAfter: null,
      lag: 0,
      failures: [],
    });
  });

  test("local longer: forwarding lag, a warning", () => {
    const texts = signedLog(key, 5, 3);
    const c = compareCopies(texts, remoteOf(texts.slice(0, 4)), { keys: [key.pub] });
    expect(c).toMatchObject({ ok: true, lag: 2, remoteHeadSeq: 4 });
    expect(c.warnings.join(" ")).toContain("forwarding lag: 2");
  });

  test("remote longer: the local tail was truncated, even when it ends at a checkpoint", () => {
    const texts = signedLog(key, 7, 3);
    const cut = texts.slice(0, 4);
    const c = compareCopies(cut, remoteOf(texts), { keys: [key.pub] });
    expect(c.ok).toBe(false);
    expect(c.truncatedAfter).toBe(4);
    expect(c.signedPastLocal).toBe(true);
    expect(c.failures[0]).toContain("local tail truncated after seq 4");
    expect(c.failures[0]).toContain("signed checkpoint");
  });

  test("content that differs at a seq both hold is a failure", () => {
    const texts = signedLog(key, 4, 3);
    const other = recompute(texts, 2, { i: 99 });
    const c = compareCopies(texts, remoteOf(other), { keys: [key.pub] });
    expect(c.ok).toBe(false);
    expect(c.failures.join(" ")).toContain("differ at seq 2");
  });

  test("a remote that does not continue the local chain diverges", () => {
    const texts = signedLog(key, 4, 3);
    const foreign = recompute(signedLog(key, 7, 3), 2, { i: 77 }).slice(5);
    const c = compareCopies(texts, remoteOf([...texts, ...foreign]), { keys: [key.pub] });
    expect(c.ok).toBe(false);
    expect(c.failures.join(" ")).toMatch(/differ at seq|diverges/);
  });

  test("gaps and duplicates in the remote are reported, not fatal; its problems are", () => {
    const texts = signedLog(key, 6, 3);
    const gappy = remoteOf([texts[0], texts[1], texts[4], texts[5]] as string[], { duplicates: 2 });
    const c = compareCopies(texts, gappy, { keys: [key.pub] });
    expect(c.ok).toBe(true);
    expect(c.warnings.join(" ")).toContain("misses seq 3..4");
    expect(c.duplicates).toBe(2);
    const bad = compareCopies(texts, remoteOf(texts, { problems: ["seq 3: 1 of 2 parts"] }), {
      keys: [key.pub],
    });
    expect(bad.ok).toBe(false);
    expect(bad.failures[0]).toContain("off-box copy: seq 3");
  });

  test("an empty remote is all lag", () => {
    const texts = signedLog(key, 2, 3);
    expect(compareCopies(texts, remoteOf([], { format: "empty" }), { keys: [] })).toMatchObject({
      ok: true,
      lag: 2,
      remoteHeadSeq: 0,
    });
  });
});
