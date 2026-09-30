import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuditLog, readAudit } from "../audit.ts";
import { dedupeBySeq, type Fault, faulty, forwarderContract } from "../testing/forward-contract.ts";
import { FileTransport } from "./file.ts";
import { CursorForwarder } from "./forwarder.ts";

const RETRY = { minMs: 5, maxMs: 20 };

forwarderContract("file", async (dir) => {
  const copy = join(dir, "remote", "copy.jsonl");
  const fault: Fault = { broken: false };
  return {
    kind: "file",
    target: copy,
    overlap: 0,
    make: (logPath, cursorPath) =>
      new CursorForwarder(faulty(new FileTransport(copy), fault), {
        logPath,
        cursorPath,
        retry: RETRY,
      }),
    received: async () => dedupeBySeq(readAudit(copy).lines),
    breakIt: async () => {
      fault.broken = true;
    },
    restore: async () => {
      fault.broken = false;
    },
    dispose: async () => {},
  };
});

describe("file forwarder", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "jev-cops-filefwd-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function forwarder(copy: string) {
    const logPath = join(dir, "audit.jsonl");
    const cursorPath = join(dir, "forward.cursor");
    return new CursorForwarder(new FileTransport(copy), { logPath, cursorPath, retry: RETRY });
  }

  test("the copy is byte-identical to the local log", async () => {
    const copy = join(dir, "copy.jsonl");
    const fwd = forwarder(copy);
    const log = AuditLog.open(join(dir, "audit.jsonl"), { forwarder: fwd });
    log.append({ kind: "boot", payload: { é: "ü" } });
    log.append({ kind: "judge", payload: {} });
    await fwd.flush(2_000);
    log.close();
    await fwd.close();
    expect(readFileSync(copy, "utf8")).toBe(readFileSync(join(dir, "audit.jsonl"), "utf8"));
  });

  test("a copy longer than the local log is an anomaly: the local tail was cut", async () => {
    const copy = join(dir, "copy.jsonl");
    const logPath = join(dir, "audit.jsonl");
    const seed = AuditLog.open(logPath);
    for (let i = 0; i < 4; i++) seed.append({ kind: "judge", payload: { i } });
    seed.close();
    writeFileSync(copy, readFileSync(logPath));
    const lines = readFileSync(logPath, "utf8").split("\n");
    writeFileSync(logPath, `${lines.slice(0, 2).join("\n")}\n`);
    const fwd = forwarder(copy);
    const log = AuditLog.open(logPath, { forwarder: fwd });
    await fwd.flush(2_000);
    log.close();
    await fwd.close();
    const reasons = readAudit(logPath)
      .lines.filter((l) => l.kind === "anomaly")
      .map((l) => String(l.payload.reason));
    expect(reasons.some((r) => r.includes("the destination holds seq 4"))).toBe(true);
  });

  test("a write to a closed copy is an error the forwarder records", async () => {
    const t = new FileTransport(join(dir, "c.jsonl"));
    await expect(t.write([])).rejects.toThrow(/not open/);
    expect(await t.close()).toBe(false);
  });
});
