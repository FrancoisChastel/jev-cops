import { readFileSync } from "node:fs";
import { type AuditLine, hashMatches, parseLine } from "../audit-line.ts";
import { SD_PREFIX } from "./syslog-format.ts";

/**
 * Reading the off-box copy back (D-103): RFC 5424 messages (one per line, as a receiver
 * writes them, or a raw RFC 5425 octet-counted stream) reassembled into audit lines, or
 * our own JSONL. Messages without a `jevcops@…` element are someone else's and skipped.
 */

/** One parsed RFC 5424 message. */
export interface SyslogMessage {
  readonly pri: number;
  readonly timestamp: string;
  readonly hostname: string;
  readonly appName: string;
  readonly procId: string;
  readonly msgId: string;
  /** Structured data: SD-ID → params. */
  readonly sd: ReadonlyMap<string, Readonly<Record<string, string>>>;
  /** MSG without its BOM. */
  readonly msg: string;
}

const HEADER = /^<(\d{1,3})>1 (\S+) (\S+) (\S+) (\S+) (\S+) /;
const ESCAPABLE = new Set(['"', "\\", "]"]);

function readValue(s: string, start: number): { value: string; end: number } | null {
  let out = "";
  for (let i = start; i < s.length; i++) {
    const c = s[i] ?? "";
    const next = s[i + 1] ?? "";
    if (c === "\\" && ESCAPABLE.has(next)) {
      out += next;
      i += 1;
    } else if (c === '"') {
      return { value: out, end: i + 1 };
    } else {
      out += c;
    }
  }
  return null;
}

function readParams(
  s: string,
  from: number,
): { params: Record<string, string>; end: number } | null {
  const params: Record<string, string> = {};
  let i = from;
  while (s[i] === " ") {
    const eq = s.indexOf("=", i + 1);
    if (eq === -1 || s[eq + 1] !== '"') return null;
    const value = readValue(s, eq + 2);
    if (value === null) return null;
    params[s.slice(i + 1, eq)] = value.value;
    i = value.end;
  }
  return { params, end: i };
}

/** STRUCTURED-DATA at the start of `s`: its elements and where it ends; null when malformed. */
function parseSd(s: string): { sd: Map<string, Record<string, string>>; end: number } | null {
  const sd = new Map<string, Record<string, string>>();
  if (s.startsWith("-")) return { sd, end: 1 };
  let i = 0;
  while (s[i] === "[") {
    const idEnd = s.slice(i + 1).search(/[ \]]/);
    if (idEnd === -1) return null;
    const read = readParams(s, i + 1 + idEnd);
    if (read === null || s[read.end] !== "]") return null;
    sd.set(s.slice(i + 1, i + 1 + idEnd), read.params);
    i = read.end + 1;
  }
  return i === 0 ? null : { sd, end: i };
}

/** Parses one RFC 5424 message; null when it is not one. */
export function parseSyslogMessage(text: string): SyslogMessage | null {
  const m = HEADER.exec(text);
  if (m === null) return null;
  const rest = text.slice(m[0].length);
  const sd = parseSd(rest);
  if (sd === null) return null;
  const tail = rest.slice(sd.end);
  if (tail !== "" && !tail.startsWith(" ")) return null;
  const msg = tail.slice(1).replace(/^﻿/, "");
  const [, pri, timestamp, hostname, appName, procId, msgId] = m;
  return {
    pri: Number(pri),
    timestamp: timestamp ?? "",
    hostname: hostname ?? "",
    appName: appName ?? "",
    procId: procId ?? "",
    msgId: msgId ?? "",
    sd: sd.sd,
    msg,
  };
}

/** Splits an RFC 5425 octet-counted stream; a trailing incomplete frame is returned as `rest`. */
export function splitOctetFrames(buf: Buffer): {
  messages: Buffer[];
  rest: Buffer;
  error: string | null;
} {
  const messages: Buffer[] = [];
  let i = 0;
  while (i < buf.length) {
    const sp = buf.indexOf(0x20, i);
    const digits = buf.subarray(i, sp === -1 ? buf.length : sp).toString("ascii");
    if (sp === -1 && /^\d*$/.test(digits)) break;
    if (!/^[1-9]\d{0,8}$/.test(digits)) {
      return { messages, rest: buf.subarray(i), error: `bad octet count at byte ${i}` };
    }
    const end = sp + 1 + Number(digits);
    if (end > buf.length) break;
    messages.push(buf.subarray(sp + 1, end));
    i = end;
  }
  return { messages, rest: buf.subarray(i), error: null };
}

/** Audit lines, one per seq, with what was wrong and how many lines arrived more than once. */
export interface Reassembled {
  readonly lines: AuditLine[];
  readonly problems: string[];
  readonly duplicates: number;
}

interface Group {
  readonly seq: number;
  readonly hash: string;
  readonly of: number;
  readonly parts: Map<number, string>;
}

function ourElement(m: SyslogMessage): Readonly<Record<string, string>> | null {
  for (const [id, params] of m.sd) if (id.startsWith(SD_PREFIX)) return params;
  return null;
}

/** Adds one message to its line's group; returns true when it repeats a part already held. */
function addPiece(groups: Map<string, Group>, p: Readonly<Record<string, string>>, msg: string) {
  const [part, of] = (p.part ?? "1/1").split("/").map(Number);
  const key = `${p.seq}|${p.hash}`;
  const group = groups.get(key) ?? {
    seq: Number(p.seq),
    hash: p.hash ?? "",
    of: of ?? 1,
    parts: new Map<number, string>(),
  };
  groups.set(key, group);
  const repeated = group.parts.has(part ?? 1);
  if (!repeated) group.parts.set(part ?? 1, msg);
  return repeated && (part ?? 1) === 1;
}

function assemble(g: Group): AuditLine | string {
  if (g.parts.size < g.of) return `seq ${g.seq}: ${g.parts.size} of ${g.of} parts received`;
  const text = [...g.parts.entries()]
    .sort(([a], [b]) => a - b)
    .map(([, t]) => t)
    .join("");
  const line = parseLine(text);
  if (line === null || line.seq !== g.seq || line.hash !== g.hash || !hashMatches(line)) {
    return `seq ${g.seq}: the message does not match its structured data (seq, hash)`;
  }
  return line;
}

/** One line per seq; a seq carried by two different lines is a problem (the first is kept). */
export function uniqueBySeq(lines: readonly AuditLine[]): Reassembled {
  const bySeq = new Map<number, AuditLine>();
  const problems: string[] = [];
  let duplicates = 0;
  for (const line of lines) {
    const held = bySeq.get(line.seq);
    if (held === undefined) bySeq.set(line.seq, line);
    else if (held.hash === line.hash) duplicates += 1;
    else problems.push(`seq ${line.seq}: two different lines in the copy`);
  }
  const unique = [...bySeq.values()].sort((a, b) => a.seq - b.seq);
  return { lines: unique, problems, duplicates };
}

/** Reassembles RFC 5424 message texts into audit lines (parts joined, resends dropped). */
export function linesFromMessages(texts: readonly string[]): Reassembled {
  const groups = new Map<string, Group>();
  const problems: string[] = [];
  let repeats = 0;
  for (const text of texts) {
    const m = parseSyslogMessage(text);
    const p = m === null ? null : ourElement(m);
    if (m === null || p === null) continue;
    if (addPiece(groups, p, m.msg)) repeats += 1;
  }
  const lines: AuditLine[] = [];
  for (const g of groups.values()) {
    const out = assemble(g);
    if (typeof out === "string") problems.push(out);
    else lines.push(out);
  }
  const unique = uniqueBySeq(lines);
  const all = [...problems, ...unique.problems];
  return { lines: unique.lines, problems: all, duplicates: repeats + unique.duplicates };
}

/** The off-box copy at `path`, whichever way it was written. */
export interface RemoteCopy extends Reassembled {
  readonly format: "jsonl" | "syslog-lines" | "syslog-frames" | "empty";
}

function fromJsonl(text: string): Reassembled {
  const problems: string[] = [];
  const lines: AuditLine[] = [];
  text.split("\n").forEach((t, i) => {
    if (t.trim() === "") return;
    const line = parseLine(t);
    if (line === null) problems.push(`line ${i + 1}: not an audit line`);
    else lines.push(line);
  });
  const unique = uniqueBySeq(lines);
  return { ...unique, problems: [...problems, ...unique.problems] };
}

/** Reads a copy: our JSONL, RFC 5424 messages one per line, or an octet-counted stream. */
export function readRemoteCopy(path: string): RemoteCopy {
  const buf = readFileSync(path);
  const first = buf.toString("utf8", 0, Math.min(buf.length, 64)).trimStart()[0];
  if (first === undefined) return { format: "empty", lines: [], problems: [], duplicates: 0 };
  if (first === "{") return { format: "jsonl", ...fromJsonl(buf.toString("utf8")) };
  if (first === "<") {
    const texts = buf
      .toString("utf8")
      .split("\n")
      .filter((t) => t !== "");
    return { format: "syslog-lines", ...linesFromMessages(texts) };
  }
  const frames = splitOctetFrames(buf);
  const out = linesFromMessages(frames.messages.map((m) => m.toString("utf8")));
  const framing = [
    ...(frames.error === null ? [] : [frames.error]),
    ...(frames.rest.length > 0 && frames.error === null ? ["the copy ends inside a frame"] : []),
  ];
  return { format: "syslog-frames", ...out, problems: [...framing, ...out.problems] };
}
