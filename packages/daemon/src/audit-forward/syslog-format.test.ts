import { describe, expect, test } from "bun:test";
import type { AuditLine } from "../audit-line.ts";
import { lineHash, lineText } from "../audit-line.ts";
import { octetFrame, type SyslogFormat, syslogMessages } from "./syslog-format.ts";
import { linesFromMessages, parseSyslogMessage, splitOctetFrames } from "./syslog-parse.ts";

const FORMAT: SyslogFormat = {
  facility: 16,
  hostname: "build-box",
  appName: "copsd",
  procId: "4242",
  enterpriseNumber: 32473,
  maxMessageBytes: 2048,
};

function line(
  over: Partial<AuditLine> = {},
  payload: Record<string, unknown> = { v: 1 },
): AuditLine {
  const body = {
    kind: "judge" as const,
    event_id: "evt_01J",
    session_id: "sess_abc",
    payload,
    seq: 7,
    at: Date.UTC(2026, 8, 30, 12, 0, 0, 123),
    prev: "a".repeat(64),
    ...over,
  };
  return { ...body, hash: lineHash(body) };
}

describe("RFC 5424 message", () => {
  test("header, structured data with the chain fields, BOM + the canonical line", () => {
    const l = line();
    const [msg] = syslogMessages(l, FORMAT);
    const text = msg?.toString("utf8") ?? "";
    const sd = `[jevcops@32473 seq="7" prev="${l.prev}" hash="${l.hash}" kind="judge" event_id="evt_01J" session_id="sess_abc"]`;
    expect(text).toBe(
      `<133>1 2026-09-30T12:00:00.123Z build-box copsd 4242 judge ${sd} ﻿${lineText(l)}`,
    );
  });

  test("anomalies are warnings, everything else notice", () => {
    const [msg] = syslogMessages(line({ kind: "anomaly" }), FORMAT);
    expect(msg?.toString("utf8").startsWith("<132>1 ")).toBe(true);
    const [boot] = syslogMessages(line({ kind: "checkpoint" }), { ...FORMAT, facility: 13 });
    expect(boot?.toString("utf8").startsWith("<109>1 ")).toBe(true);
  });

  test("a hostname outside printable ASCII is replaced; ids are escaped and capped", () => {
    const weird = `sess_"]\\${"x".repeat(300)}`;
    const [msg] = syslogMessages(line({ session_id: weird }), { ...FORMAT, hostname: "héllo box" });
    const text = msg?.toString("utf8") ?? "";
    expect(text).toContain(" h-llo-box copsd ");
    expect(text).toContain('session_id="sess_\\"\\]\\\\xxx');
    const parsed = parseSyslogMessage(text);
    const sid = parsed?.sd.get("jevcops@32473")?.session_id ?? "";
    expect(sid.startsWith('sess_"]\\x')).toBe(true);
    expect(Buffer.byteLength(sid)).toBeLessThanOrEqual(128);
  });

  test("a line longer than the limit is split into parts that each fit and reassemble", () => {
    const big = line({}, { text: "é".repeat(4_000), more: "z".repeat(3_000) });
    const parts = syslogMessages(big, FORMAT);
    expect(parts.length).toBeGreaterThan(3);
    for (const p of parts) expect(p.length).toBeLessThanOrEqual(FORMAT.maxMessageBytes);
    const texts = parts.map((p) => p.toString("utf8"));
    expect(texts[0]).toContain(` part="1/${parts.length}"]`);
    expect(texts.every((t) => !t.includes("�"))).toBe(true);
    const back = linesFromMessages([...texts].reverse());
    expect(back).toEqual({ lines: [big], problems: [], duplicates: 0 });
  });
});

describe("RFC 5425 octet counting", () => {
  test("MSG-LEN SP SYSLOG-MSG, the length in octets", () => {
    const msg = Buffer.from("<133>1 é");
    expect(octetFrame(msg).toString("utf8")).toBe("9 <133>1 é");
  });

  test("frames split back, a partial frame is kept for later", () => {
    const a = octetFrame(Buffer.from("<133>1 a"));
    const b = octetFrame(Buffer.from("<133>1 bb"));
    const stream = Buffer.concat([a, b, Buffer.from("12 <13")]);
    const out = splitOctetFrames(stream);
    expect(out.messages.map((m) => m.toString())).toEqual(["<133>1 a", "<133>1 bb"]);
    expect(out.rest.toString()).toBe("12 <13");
    expect(out.error).toBeNull();
  });

  test("a frame that does not start with a length is an error", () => {
    expect(splitOctetFrames(Buffer.from("<133>1 no length")).error).toContain("octet count");
    expect(splitOctetFrames(Buffer.from("0 x")).error).toContain("octet count");
  });
});
