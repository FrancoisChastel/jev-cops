import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readCursor, writeCursor } from "./cursor.ts";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "jev-cops-cursor-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("forward cursor", () => {
  test("round-trips, private, for its own destination only", () => {
    const path = join(dir, "sub", "forward.cursor");
    const cursor = { kind: "syslog", target: "h:1", seq: 7, hash: "ab", clean: true } as const;
    writeCursor(path, cursor);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(readCursor(path, "syslog", "h:1")).toEqual(cursor);
    expect(readCursor(path, "syslog", "other:1")).toBeNull();
    expect(readCursor(path, "file", "h:1")).toBeNull();
  });

  test("absent or corrupt is null (ship from the start)", () => {
    const path = join(dir, "forward.cursor");
    expect(readCursor(path, "file", "x")).toBeNull();
    writeFileSync(path, "{nope");
    expect(readCursor(path, "file", "x")).toBeNull();
    writeFileSync(path, JSON.stringify({ kind: "file", target: "x", seq: -1 }));
    expect(readCursor(path, "file", "x")).toBeNull();
  });
});
