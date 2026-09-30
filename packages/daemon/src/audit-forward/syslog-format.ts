import { type AuditLine, lineText } from "../audit-line.ts";

/**
 * One audit line as RFC 5424 messages (D-103), framed per RFC 5425 §4.3.1:
 *
 *   MSG-LEN SP <PRI>1 TIMESTAMP HOSTNAME APP-NAME PROCID MSGID [jevcops@PEN seq="…" prev="…"
 *   hash="…" kind="…" event_id="…" session_id="…"] BOM canonical-JSON-line
 *
 * `seq`/`prev`/`hash` travel in the structured data so a receiver can rebuild the chain
 * without parsing MSG. A line longer than the message limit is split into parts carrying
 * `part="i/n"`, cut on UTF-8 character boundaries; the verifier reassembles them.
 */

/** How messages are built: facility, header fields, the SD-ID's enterprise number, the size limit. */
export interface SyslogFormat {
  readonly facility: number;
  readonly hostname: string;
  readonly appName: string;
  readonly procId: string;
  readonly enterpriseNumber: number;
  /** Largest SYSLOG-MSG in octets. */
  readonly maxMessageBytes: number;
}

/** The SD-ID prefix of our structured data element (`jevcops@<PEN>`). */
export const SD_PREFIX = "jevcops@";
const SEVERITY_WARNING = 4;
const SEVERITY_NOTICE = 5;
const BOM = Buffer.from([0xef, 0xbb, 0xbf]);
/** SD values that are metadata only (event and session ids) are capped at this many octets. */
const MAX_ID_BYTES = 128;
const MAX_HOSTNAME = 255;

/** Printable US-ASCII only (RFC 5424 PRINTUSASCII), at most `max` characters, else "-". */
function printable(text: string, max: number): string {
  const out = [...text]
    .map((c) => (c >= "!" && c <= "~" ? c : "-"))
    .join("")
    .slice(0, max);
  return out === "" ? "-" : out;
}

/** `text` cut to at most `max` UTF-8 octets, never inside a character. */
function capUtf8(text: string, max: number): string {
  const bytes = Buffer.from(text, "utf8");
  if (bytes.length <= max) return text;
  let end = max;
  while (end > 0 && ((bytes[end] ?? 0) & 0xc0) === 0x80) end -= 1;
  return bytes.subarray(0, end).toString("utf8");
}

/** RFC 5424 §6.3.3: `"`, `\` and `]` are escaped with a backslash in PARAM-VALUE. */
function escapeParam(value: string): string {
  return value.replace(/["\\\]]/g, (c) => `\\${c}`);
}

function sdElement(line: AuditLine, pen: number, part: string | null): string {
  const params: [string, string][] = [
    ["seq", String(line.seq)],
    ["prev", line.prev],
    ["hash", line.hash],
    ["kind", line.kind],
  ];
  if (line.event_id !== undefined) params.push(["event_id", capUtf8(line.event_id, MAX_ID_BYTES)]);
  if (line.session_id !== undefined) {
    params.push(["session_id", capUtf8(line.session_id, MAX_ID_BYTES)]);
  }
  if (part !== null) params.push(["part", part]);
  const body = params.map(([k, v]) => `${k}="${escapeParam(v)}"`).join(" ");
  return `[${SD_PREFIX}${pen} ${body}]`;
}

function header(line: AuditLine, f: SyslogFormat): string {
  const severity = line.kind === "anomaly" ? SEVERITY_WARNING : SEVERITY_NOTICE;
  const pri = f.facility * 8 + severity;
  const fields = [
    new Date(line.at).toISOString(),
    printable(f.hostname, MAX_HOSTNAME),
    printable(f.appName, 48),
    printable(f.procId, 128),
    printable(line.kind, 32),
  ];
  return `<${pri}>1 ${fields.join(" ")}`;
}

/** `bytes` in chunks of at most `max` octets, each ending on a UTF-8 character boundary. */
function splitUtf8(bytes: Buffer, max: number): Buffer[] {
  const chunks: Buffer[] = [];
  let start = 0;
  while (start < bytes.length) {
    let end = Math.min(bytes.length, start + max);
    while (end < bytes.length && end > start && ((bytes[end] ?? 0) & 0xc0) === 0x80) end -= 1;
    chunks.push(bytes.subarray(start, end));
    start = end;
  }
  return chunks;
}

function message(head: string, sd: string, msg: Buffer): Buffer {
  return Buffer.concat([Buffer.from(`${head} ${sd} `, "utf8"), BOM, msg]);
}

/** The RFC 5424 message(s) for one line: one, or `n` parts when it exceeds the limit. */
export function syslogMessages(line: AuditLine, f: SyslogFormat): Buffer[] {
  const head = header(line, f);
  const text = Buffer.from(lineText(line), "utf8");
  const whole = message(head, sdElement(line, f.enterpriseNumber, null), text);
  if (whole.length <= f.maxMessageBytes) return [whole];
  const width = String(text.length).length;
  const reserve = sdElement(line, f.enterpriseNumber, `${"9".repeat(width)}/${"9".repeat(width)}`);
  const budget = f.maxMessageBytes - Buffer.byteLength(`${head} ${reserve} `) - BOM.length;
  if (budget < 64) throw new Error(`max_message_bytes ${f.maxMessageBytes} leaves no room for MSG`);
  const chunks = splitUtf8(text, budget);
  return chunks.map((chunk, i) =>
    message(head, sdElement(line, f.enterpriseNumber, `${i + 1}/${chunks.length}`), chunk),
  );
}

/** RFC 5425 octet-counting framing: `MSG-LEN SP SYSLOG-MSG`. */
export function octetFrame(msg: Buffer): Buffer {
  return Buffer.concat([Buffer.from(`${msg.length} `, "ascii"), msg]);
}
