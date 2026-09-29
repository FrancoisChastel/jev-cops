import { afterAll, describe, expect, test } from "bun:test";
import {
  lstatSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  entryChanged,
  type IndexEntry,
  MAX_WORKTREE_ENTRIES,
  parseIndexListing,
  worktreeDirty,
} from "./git-dirty.ts";

const dir = realpathSync(mkdtempSync(join(tmpdir(), "jvdirty-")));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const OID = "a".repeat(40);
const NS = 1_000_000_000n;

function listed(e: IndexEntry): string {
  return [
    `${e.mode} ${OID} ${e.stage}\t${e.path}\0`,
    "  ctime: 1:0\n",
    `  mtime: ${e.mtimeSec}:${e.mtimeNsec}\n`,
    "  dev: 1\tino: 2\n",
    "  uid: 501\tgid: 20\n",
    `  size: ${e.size}\tflags: 0\n`,
  ].join("");
}

/** A file at `name` and the index entry that matches it exactly. */
function tracked(name: string, text = "x", at = new Date("2026-01-01T00:00:00Z")): IndexEntry {
  writeFileSync(join(dir, name), text);
  utimesSync(join(dir, name), at, at);
  const st = lstatSync(join(dir, name), { bigint: true });
  return {
    mode: "100644",
    stage: 0,
    path: name,
    mtimeSec: Number(st.mtimeNs / NS),
    mtimeNsec: Number(st.mtimeNs % NS),
    size: Number(st.size),
  };
}

const LATER = 2_000_000_000n * NS;

describe("parseIndexListing", () => {
  test("parses entries, paths with spaces and newlines included", () => {
    const a = tracked("a b.txt");
    const b = { ...a, path: "odd\nname", mode: "100755" };
    expect(parseIndexListing(listed(a) + listed(b))).toEqual([a, b]);
    expect(parseIndexListing("")).toEqual([]);
  });

  test("anything that does not match the format is unknown, not clean", () => {
    expect(parseIndexListing(`${listed(tracked("a"))}garbage`)).toBeNull();
    expect(parseIndexListing("100644 xyz 0\ta\0")).toBeNull();
  });
});

describe("entryChanged", () => {
  test("an untouched file indexed before the index was written is unchanged", () => {
    expect(entryChanged(tracked("same"), dir, LATER)).toBe(false);
  });

  test.each([
    ["size", (e: IndexEntry) => ({ ...e, size: e.size + 1 })],
    ["mtime seconds", (e: IndexEntry) => ({ ...e, mtimeSec: e.mtimeSec - 1 })],
    ["mtime nanoseconds", (e: IndexEntry) => ({ ...e, mtimeNsec: e.mtimeNsec + 1 })],
    ["an unmerged stage", (e: IndexEntry) => ({ ...e, stage: 2 })],
    ["a missing file", (e: IndexEntry) => ({ ...e, path: "gone" })],
    ["a symlink entry for a regular file", (e: IndexEntry) => ({ ...e, mode: "120000" })],
  ])("%s → changed", (_name, change) => {
    expect(entryChanged(change(tracked("f")), dir, LATER)).toBe(true);
  });

  test("a regular-file entry for a symlink is changed; submodules are skipped", () => {
    symlinkSync("target", join(dir, "link"));
    const st = lstatSync(join(dir, "link"), { bigint: true });
    const link = {
      mode: "120000",
      stage: 0,
      path: "link",
      mtimeSec: Number(st.mtimeNs / NS),
      mtimeNsec: Number(st.mtimeNs % NS),
      size: Number(st.size),
    };
    expect(entryChanged(link, dir, LATER)).toBe(false);
    expect(entryChanged({ ...link, mode: "100644" }, dir, LATER)).toBe(true);
    expect(entryChanged({ ...link, mode: "160000", path: "missing" }, dir, LATER)).toBe(false);
  });

  test("racily clean (written no earlier than the index) counts as changed", () => {
    const e = tracked("racy", "x", new Date("2026-01-01T00:00:00.123Z"));
    expect(e.mtimeNsec).toBe(123_000_000);
    const entryNs = BigInt(e.mtimeSec) * NS + BigInt(e.mtimeNsec);
    expect(entryChanged(e, dir, entryNs)).toBe(true);
    expect(entryChanged(e, dir, entryNs + 1n)).toBe(false);
  });

  test("an index without nanoseconds compares whole seconds", () => {
    const whole = new Date("2026-01-01T00:00:00Z");
    const e = { ...tracked("secs", "x", whole), mtimeNsec: 0 };
    const sec = BigInt(e.mtimeSec) * NS;
    expect(entryChanged(e, dir, sec + NS)).toBe(false);
    expect(entryChanged(e, dir, sec + NS - 1n)).toBe(true);
  });
});

describe("worktreeDirty", () => {
  const index = join(dir, "index");
  writeFileSync(index, "");

  test("clean, dirty, empty", () => {
    const a = tracked("wa");
    const b = tracked("wb");
    expect(worktreeDirty(listed(a) + listed(b), dir, index, Infinity)).toBe(false);
    writeFileSync(join(dir, "wb"), "longer");
    expect(worktreeDirty(listed(a) + listed(b), dir, index, Infinity)).toBe(true);
    expect(worktreeDirty("", dir, join(dir, "no-index"), Infinity)).toBe(false);
  });

  test("unknown: bad listing, unreadable index, too many entries, deadline passed", () => {
    const a = tracked("wc");
    expect(worktreeDirty("nope", dir, index, Infinity)).toBeNull();
    expect(worktreeDirty(listed(a), dir, join(dir, "no-index"), Infinity)).toBeNull();
    expect(worktreeDirty(listed(a), dir, index, 0)).toBeNull();
    const many = listed(a).repeat(MAX_WORKTREE_ENTRIES + 1);
    expect(worktreeDirty(many, dir, index, Infinity)).toBeNull();
  });
});
