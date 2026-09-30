import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findLastLine, lineEndAfter, readLinesFrom, readTailLine } from "./audit-read.ts";

let dir: string;
let path: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "jev-cops-read-"));
  path = join(dir, "audit.jsonl");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function line(seq: number, kind = "judge", extra = ""): string {
  return JSON.stringify({ seq, at: seq, prev: "p", hash: `h${seq}`, kind, payload: { extra } });
}

describe("readTailLine", () => {
  test("the last line and whether the file ends with a newline", () => {
    writeFileSync(path, `${line(1)}\n${line(2)}\n\n`);
    expect(readTailLine(path)).toEqual({ last: line(2), endsWithNewline: true });
  });

  test("an empty or missing file has no line", () => {
    expect(readTailLine(path)).toEqual({ last: null, endsWithNewline: true });
    writeFileSync(path, "");
    expect(readTailLine(path)).toEqual({ last: null, endsWithNewline: true });
    writeFileSync(path, "\n\n");
    expect(readTailLine(path)).toEqual({ last: null, endsWithNewline: true });
  });

  test("a partial last line is reported as such", () => {
    writeFileSync(path, `${line(1)}\n{"seq":2`);
    expect(readTailLine(path)).toEqual({ last: '{"seq":2', endsWithNewline: false });
  });
});

describe("findLastLine", () => {
  test("scans backwards across chunks for the last matching line", () => {
    const big = "x".repeat(200);
    const texts = Array.from({ length: 50 }, (_, i) =>
      line(i + 1, i === 9 ? "checkpoint" : "judge", big),
    );
    writeFileSync(path, `${texts.join("\n")}\n`);
    const found = findLastLine(path, (l) => l.kind === "checkpoint", 256);
    expect(found?.line.seq).toBe(10);
    const endOf10 = texts.slice(0, 10).reduce((n, t) => n + Buffer.byteLength(t) + 1, 0);
    expect(found?.end).toBe(endOf10);
  });

  test("null when nothing matches or the file is missing", () => {
    expect(findLastLine(path, () => true)).toBeNull();
    writeFileSync(path, `${line(1)}\n`);
    expect(findLastLine(path, (l) => l.kind === "checkpoint")).toBeNull();
  });

  test("skips blank and unparseable lines, including multi-byte text across chunks", () => {
    writeFileSync(path, `${line(1, "judge", "é".repeat(300))}\n\nnot json\n${line(2)}\n`);
    expect(findLastLine(path, (l) => l.seq === 1, 64)?.line.payload).toEqual({
      extra: "é".repeat(300),
    });
  });
});

describe("lineEndAfter", () => {
  test("the byte offset just after the line with the given seq, and its hash", () => {
    writeFileSync(path, `${line(1)}\n${line(2)}\n${line(3)}\n`);
    const at = lineEndAfter(path, 2);
    expect(at).toEqual({ offset: Buffer.byteLength(`${line(1)}\n${line(2)}\n`), hash: "h2" });
  });

  test("seq 0 is the start of the file; an unknown seq is null", () => {
    writeFileSync(path, `${line(1)}\n`);
    expect(lineEndAfter(path, 0)).toEqual({ offset: 0, hash: null });
    expect(lineEndAfter(path, 7)).toBeNull();
  });

  test("a seq below the first line's resolves to the start", () => {
    writeFileSync(path, `${line(5)}\n${line(6)}\n`);
    expect(lineEndAfter(path, 3)).toEqual({ offset: 0, hash: null });
  });
});

describe("readLinesFrom", () => {
  test("complete lines from an offset, with the offset after each", () => {
    writeFileSync(path, `${line(1)}\n${line(2)}\n${line(3)}`);
    const start = Buffer.byteLength(`${line(1)}\n`);
    const read = readLinesFrom(path, start, 10);
    expect(read.lines.map((l) => l.line.seq)).toEqual([2]);
    expect(read.lines[0]?.end).toBe(start + Buffer.byteLength(`${line(2)}\n`));
    expect(read.size).toBe(Buffer.byteLength(`${line(1)}\n${line(2)}\n${line(3)}`));
  });

  test("stops at maxLines and reads a line longer than one chunk", () => {
    const long = line(2, "judge", "y".repeat(5_000));
    writeFileSync(path, `${line(1)}\n${long}\n${line(3)}\n`);
    const read = readLinesFrom(path, 0, 2, 1_024);
    expect(read.lines.map((l) => l.line.seq)).toEqual([1, 2]);
  });

  test("skips garbage lines but moves past them", () => {
    writeFileSync(path, `garbage\n${line(4)}\n`);
    const read = readLinesFrom(path, 0, 10);
    expect(read.lines.map((l) => l.line.seq)).toEqual([4]);
    expect(read.consumed).toBe(Buffer.byteLength(`garbage\n${line(4)}\n`));
  });

  test("a missing file reads nothing", () => {
    expect(readLinesFrom(path, 0, 5)).toEqual({ lines: [], size: 0, consumed: 0 });
  });
});
