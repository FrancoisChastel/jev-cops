import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AUDIT_GENESIS, AuditLog, readAudit, verifyChain } from "./audit.ts";

let dir: string;
let path: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "jev-cops-audit-"));
  path = join(dir, "sub", "audit.jsonl");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function writeThree(p = path): AuditLog {
  let at = 1_000;
  const log = AuditLog.open(p, { now: () => at++ });
  log.append({ kind: "boot", payload: { version: "0.0.0" } });
  log.append({
    kind: "judge",
    event_id: "evt_1",
    session_id: "sess_1",
    payload: { verdict: "allow" },
  });
  log.append({ kind: "observe", event_id: "evt_2", session_id: "sess_1", payload: { ok: true } });
  return log;
}

function fileLines(): string[] {
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((l) => l !== "");
}

function rewrite(lines: string[]): void {
  writeFileSync(path, `${lines.join("\n")}\n`);
}

describe("appending", () => {
  test("lines are numbered from 1 and chained from the genesis constant", () => {
    writeThree().close();
    const { lines, problems } = readAudit(path);
    expect(problems).toEqual([]);
    expect(lines.map((l) => l.seq)).toEqual([1, 2, 3]);
    expect(lines[0]?.prev).toBe(AUDIT_GENESIS);
    expect(lines[1]?.prev).toBe(lines[0]?.hash ?? "");
    expect(lines[2]?.prev).toBe(lines[1]?.hash ?? "");
    expect(lines[1]).toMatchObject({ kind: "judge", event_id: "evt_1", session_id: "sess_1" });
  });

  test("the chain verifies", () => {
    writeThree().close();
    expect(verifyChain(path)).toEqual({ ok: true, lines: 3 });
  });

  test("reopening continues the chain where it stopped", () => {
    writeThree().close();
    const log = AuditLog.open(path);
    const line = log.append({ kind: "anomaly", payload: { reason: "x" } });
    log.close();
    expect(line.seq).toBe(4);
    expect(verifyChain(path)).toEqual({ ok: true, lines: 4 });
  });

  test("the file is private to the daemon's user", () => {
    writeThree().close();
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  test("undefined payload fields are dropped, so what is hashed is what is written", () => {
    const log = AuditLog.open(path);
    log.append({ kind: "boot", payload: { a: undefined, b: [1, undefined], c: "x" } });
    log.close();
    expect(verifyChain(path).ok).toBe(true);
    expect(readAudit(path).lines[0]?.payload).toEqual({ b: [1, null], c: "x" });
  });

  test("a closed log refuses appends and closing twice is harmless", () => {
    const log = AuditLog.open(path);
    log.close();
    log.close();
    expect(() => log.append({ kind: "boot", payload: {} })).toThrow(/closed/);
  });

  test("a forward file receives byte-identical lines", () => {
    const fwd = join(dir, "copy.jsonl");
    const log = AuditLog.open(path, { forward: fwd });
    log.append({ kind: "boot", payload: {} });
    log.close();
    expect(readFileSync(fwd, "utf8")).toBe(readFileSync(path, "utf8"));
  });

  test("an unparseable tail restarts the chain with an anomaly, which verification flags", () => {
    writeThree().close();
    writeFileSync(path, `${readFileSync(path, "utf8")}{"seq":4,"trunc`);
    const log = AuditLog.open(path);
    const line = log.append({ kind: "boot", payload: {} });
    log.close();
    expect(readAudit(path).lines.some((l) => l.kind === "anomaly")).toBe(true);
    expect(line.seq).toBeGreaterThan(3);
    expect(verifyChain(path).ok).toBe(false);
  });
});

describe("verifyChain (T12: a chain break is an alert)", () => {
  test("editing a middle line breaks at that seq", () => {
    writeThree().close();
    const lines = fileLines();
    rewrite([lines[0] ?? "", (lines[1] ?? "").replace('"allow"', '"deny"'), lines[2] ?? ""]);
    expect(verifyChain(path)).toMatchObject({ ok: false, brokenAt: 2 });
  });

  test("deleting a middle line breaks at the next one", () => {
    writeThree().close();
    const lines = fileLines();
    rewrite([lines[0] ?? "", lines[2] ?? ""]);
    expect(verifyChain(path)).toMatchObject({ ok: false, brokenAt: 3 });
  });

  test("dropping the head breaks at the first remaining line", () => {
    writeThree().close();
    rewrite(fileLines().slice(1));
    expect(verifyChain(path)).toMatchObject({ ok: false, brokenAt: 2 });
  });

  test("a line cut mid-way breaks at its seq", () => {
    writeThree().close();
    const lines = fileLines();
    rewrite([lines[0] ?? "", lines[1] ?? "", (lines[2] ?? "").slice(0, 20)]);
    expect(verifyChain(path)).toMatchObject({ ok: false, brokenAt: 3 });
  });

  test("recomputing a forged line's hash still breaks the next line's prev", () => {
    writeThree().close();
    const lines = fileLines().map((l) => JSON.parse(l) as Record<string, unknown>);
    const forged = { ...lines[1], payload: { verdict: "deny" } };
    // A forger without the previous hashes' preimages can rehash line 2, but line 3's
    // prev still names the original line 2.
    rewrite([JSON.stringify(lines[0]), JSON.stringify(forged), JSON.stringify(lines[2])]);
    expect(verifyChain(path).ok).toBe(false);
  });

  test("a missing file is an empty, valid chain", () => {
    expect(verifyChain(join(dir, "none.jsonl"))).toEqual({ ok: true, lines: 0 });
  });
});
