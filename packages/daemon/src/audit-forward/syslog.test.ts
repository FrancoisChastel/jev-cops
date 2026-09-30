import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { type AddressInfo, createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuditLog, readAudit } from "../audit.ts";
import type { SyslogSettings } from "../config-audit.ts";
import { forwarderContract, waitFor } from "../testing/forward-contract.ts";
import { type SyslogReceiver, startSyslogReceiver } from "../testing/syslog-receiver.ts";
import { selfSignedCert } from "../testing/tls-cert.ts";
import { readCursor } from "./cursor.ts";
import { CursorForwarder } from "./forwarder.ts";
import { SyslogTransport } from "./syslog.ts";
import { linesFromMessages, parseSyslogMessage, readRemoteCopy } from "./syslog-parse.ts";

const RETRY = { minMs: 10, maxMs: 50 };

function settings(dir: string, port: number, ca: string, over: Partial<SyslogSettings> = {}) {
  const caFile = join(dir, `ca-${port}.pem`);
  writeFileSync(caFile, ca);
  return {
    host: "127.0.0.1",
    port,
    ca: caFile,
    cert: null,
    key: null,
    serverName: null,
    facility: 16,
    appName: "copsd",
    enterpriseNumber: 32473,
    maxMessageBytes: 2048,
    resendOverlap: 3,
    ...over,
  } satisfies SyslogSettings;
}

forwarderContract("syslog", async (dir) => {
  const receiver = await startSyslogReceiver();
  const s = settings(dir, receiver.port, receiver.cert.cert);
  return {
    kind: "syslog",
    target: `127.0.0.1:${receiver.port}`,
    overlap: s.resendOverlap,
    // settleMs 0: a drop rewinds by the overlap only, which bounds the duplicates.
    make: (logPath, cursorPath) =>
      new CursorForwarder(new SyslogTransport(s, { hostname: "box", procId: "1" }), {
        logPath,
        cursorPath,
        retry: RETRY,
        settleMs: 0,
      }),
    received: async () => {
      const r = linesFromMessages(receiver.messages());
      return { lines: r.lines, duplicates: r.duplicates };
    },
    breakIt: () => receiver.stop(),
    restore: () => receiver.start(),
    dispose: () => receiver.close(),
  };
});

describe("syslog forwarder over TLS", () => {
  let dir: string;
  let receiver: SyslogReceiver;
  let logPath: string;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "jev-cops-syslog-"));
    logPath = join(dir, "audit.jsonl");
    receiver = await startSyslogReceiver();
  });

  afterEach(async () => {
    await receiver.close();
    rmSync(dir, { recursive: true, force: true });
  });

  function forwarder(s: SyslogSettings) {
    const transport = new SyslogTransport(s, { hostname: "box", procId: "7" });
    return new CursorForwarder(transport, {
      logPath,
      cursorPath: join(dir, "forward.cursor"),
      retry: RETRY,
    });
  }

  async function ship(s: SyslogSettings, entries: number, payload: Record<string, unknown> = {}) {
    const fwd = forwarder(s);
    const log = AuditLog.open(logPath, { forwarder: fwd });
    log.append({ kind: "anomaly", event_id: "evt_x", session_id: "sess_y", payload });
    for (let i = 1; i < entries; i++) log.append({ kind: "judge", payload: { i, ...payload } });
    const flushed = await fwd.flush(3_000);
    log.close();
    await fwd.close();
    return { flushed, status: fwd.status() };
  }

  test("framing, header and structured data as a receiver sees them", async () => {
    await ship(settings(dir, receiver.port, receiver.cert.cert), 2);
    const [first, second] = await waitFor(
      () => receiver.messages(),
      (m) => m.length >= 2,
    );
    expect(receiver.errors()).toEqual([]);
    const local = readAudit(logPath).lines;
    const a = parseSyslogMessage(first ?? "");
    expect(a).toMatchObject({ pri: 132, hostname: "box", appName: "copsd", procId: "7" });
    expect(a?.msgId).toBe("anomaly");
    expect(a?.sd.get("jevcops@32473")).toEqual({
      seq: "1",
      prev: local[0]?.prev ?? "",
      hash: local[0]?.hash ?? "",
      kind: "anomaly",
      event_id: "evt_x",
      session_id: "sess_y",
    });
    expect(parseSyslogMessage(second ?? "")?.pri).toBe(133);
    const frames = receiver.frames().toString("utf8");
    expect(frames.startsWith(`${Buffer.byteLength(first ?? "")} <132>1 `)).toBe(true);
  });

  test("lines above the size limit arrive in parts and reassemble exactly", async () => {
    const big = { text: "ü".repeat(3_000) };
    await ship(settings(dir, receiver.port, receiver.cert.cert), 3, big);
    const messages = await waitFor(
      () => receiver.messages(),
      (m) => linesFromMessages(m).lines.length >= 3,
    );
    expect(messages.length).toBeGreaterThan(3);
    for (const m of messages) expect(Buffer.byteLength(m)).toBeLessThanOrEqual(2048);
    expect(linesFromMessages(messages).lines).toEqual(readAudit(logPath).lines);
  });

  test("a receiver whose certificate does not chain to ca_file gets nothing", async () => {
    const other = selfSignedCert();
    const { flushed, status } = await ship(settings(dir, receiver.port, other.cert), 2);
    expect(flushed).toBe(false);
    expect(status.connected).toBe(false);
    expect(status.lastError).toMatch(/certificate/i);
    expect(receiver.messages()).toEqual([]);
  });

  test("a receiver that requires a client certificate: refused without (nothing counted as sent), all arrives with", async () => {
    const client = selfSignedCert("copsd-client");
    const strict = await startSyslogReceiver({ clientCa: client.cert });
    try {
      const base = settings(dir, strict.port, strict.cert.cert);
      const fwd = forwarder(base);
      const log = AuditLog.open(logPath, { forwarder: fwd });
      log.append({ kind: "judge", payload: { n: 1 } });
      log.append({ kind: "judge", payload: { n: 2 } });
      const refused = await waitFor(
        () => fwd.status(),
        (s) => s.lastError !== null,
      );
      expect(refused.lastError).not.toBeNull();
      log.close();
      await fwd.close();
      expect(strict.messages()).toEqual([]);
      const cursorPath = join(dir, "forward.cursor");
      expect(readCursor(cursorPath, "syslog", `127.0.0.1:${strict.port}`)?.seq).toBe(0);
      writeFileSync(join(dir, "client.pem"), client.cert);
      writeFileSync(join(dir, "client.key"), client.key);
      const withCert = { ...base, cert: join(dir, "client.pem"), key: join(dir, "client.key") };
      const shipped = await ship(withCert, 1);
      expect(shipped.flushed).toBe(true);
      const got = await waitFor(
        () => linesFromMessages(strict.messages()).lines,
        (l) => l.length >= 3,
      );
      expect(got).toEqual(readAudit(logPath).lines);
    } finally {
      await strict.close();
    }
  });

  test("a peer that never completes the TLS handshake times out", async () => {
    const silent = createNetServer(() => {});
    await new Promise<void>((r) => silent.listen(0, "127.0.0.1", () => r()));
    const port = (silent.address() as AddressInfo).port;
    try {
      const t = new SyslogTransport(settings(dir, port, receiver.cert.cert), {
        timeouts: { connectMs: 50 },
      });
      await expect(t.connect()).rejects.toThrow(/timed out/);
      expect(await t.close()).toBe(false);
      await expect(t.write([])).rejects.toThrow(/not connected/);
    } finally {
      silent.close();
    }
  });

  test("an unreadable CA file is reported as the forwarder's error", async () => {
    const s = { ...settings(dir, receiver.port, receiver.cert.cert), ca: join(dir, "none.pem") };
    const { status } = await ship(s, 1);
    expect(status.lastError).toContain("cannot read the syslog CA file");
  });

  test("the raw capture reads back as the off-box copy", async () => {
    await ship(settings(dir, receiver.port, receiver.cert.cert), 4, { t: "x".repeat(2_500) });
    await waitFor(
      () => linesFromMessages(receiver.messages()).lines,
      (l) => l.length >= 4,
    );
    const capture = join(dir, "capture.raw");
    writeFileSync(capture, receiver.frames());
    const copy = readRemoteCopy(capture);
    expect(copy.format).toBe("syslog-frames");
    expect(copy.problems).toEqual([]);
    expect(copy.lines).toEqual(readAudit(logPath).lines);
    const perLine = join(dir, "capture.log");
    writeFileSync(perLine, `${receiver.messages().join("\n")}\n`);
    expect(readRemoteCopy(perLine)).toMatchObject({ format: "syslog-lines", problems: [] });
  });
});
