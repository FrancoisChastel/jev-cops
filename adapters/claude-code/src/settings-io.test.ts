import { afterEach, describe, expect, test } from "bun:test";
import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  backupPath,
  detectIndent,
  type InstallFs,
  NODE_INSTALL_FS,
  removeFile,
  serializeSettings,
  writeFileAtomic,
} from "./settings-io.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function temp(): string {
  const d = realpathSync(mkdtempSync(join(tmpdir(), "jvcc-io-")));
  dirs.push(d);
  return d;
}
const NOW = new Date("2026-09-29T09:12:00.123Z");
const mode = (p: string) => statSync(p).mode & 0o777;

describe("serializeSettings", () => {
  test("keeps the file's indentation and ends with a newline", () => {
    expect(serializeSettings({ a: [1] }, null)).toBe('{\n  "a": [\n    1\n  ]\n}\n');
    expect(serializeSettings({ a: 1 }, '{\n    "x": 1\n}')).toBe('{\n    "a": 1\n}\n');
    expect(serializeSettings({ a: 1 }, '{\n\t"x": 1\n}')).toBe('{\n\t"a": 1\n}\n');
  });

  test("detectIndent falls back to two spaces", () => {
    expect(detectIndent("{}")).toBe("  ");
    expect(detectIndent('{"a":1}')).toBe("  ");
    expect(detectIndent('{\n      "deep": 1\n}')).toBe("      ");
  });
});

describe("writeFileAtomic", () => {
  test("creates the directory and the file with the requested mode, no backup when new", () => {
    const dir = temp();
    const path = join(dir, ".claude", "settings.json");
    const out = writeFileAtomic(path, "{}\n", { mode: 0o600, dirMode: 0o700, now: NOW });
    expect(out.backup).toBeNull();
    expect(readFileSync(path, "utf8")).toBe("{}\n");
    expect(mode(path)).toBe(0o600);
    expect(mode(join(dir, ".claude"))).toBe(0o700);
    expect(readdirSync(join(dir, ".claude"))).toEqual(["settings.json"]);
  });

  test("backs up the previous content with a timestamped name, then replaces it", () => {
    const dir = temp();
    const path = join(dir, "settings.json");
    writeFileSync(path, '{"old":true}\n', { mode: 0o644 });
    const out = writeFileAtomic(path, "{}\n", { mode: 0o600, dirMode: 0o700, now: NOW });
    expect(out.backup).toBe(`${path}.jev-cops-20260929T091200123Z.bak`);
    expect(readFileSync(out.backup ?? "", "utf8")).toBe('{"old":true}\n');
    expect(mode(out.backup ?? "")).toBe(0o600);
    expect(readFileSync(path, "utf8")).toBe("{}\n");
    expect(mode(path)).toBe(0o600);
  });

  test("a second backup in the same millisecond gets its own name", () => {
    const dir = temp();
    const path = join(dir, "s.json");
    writeFileSync(path, "1");
    const first = writeFileAtomic(path, "2", { mode: 0o644, dirMode: 0o755, now: NOW }).backup;
    const second = writeFileAtomic(path, "3", { mode: 0o644, dirMode: 0o755, now: NOW }).backup;
    expect(second).not.toBe(first);
    expect(second).toBe(`${path}.jev-cops-20260929T091200123Z-2.bak`);
    expect(backupPath(path, NOW, NODE_INSTALL_FS)).toBe(
      `${path}.jev-cops-20260929T091200123Z-3.bak`,
    );
    expect(readFileSync(second ?? "", "utf8")).toBe("2");
  });

  test("backup: false skips the copy", () => {
    const dir = temp();
    const path = join(dir, "s.json");
    writeFileSync(path, "1");
    const out = writeFileAtomic(path, "2", {
      mode: 0o644,
      dirMode: 0o755,
      now: NOW,
      backup: false,
    });
    expect(out.backup).toBeNull();
    expect(readdirSync(dir)).toEqual(["s.json"]);
  });

  test("a failed rename leaves the old file intact and no temp file behind", () => {
    const dir = temp();
    const path = join(dir, "settings.json");
    writeFileSync(path, "OLD");
    const fs: InstallFs = {
      ...NODE_INSTALL_FS,
      rename: () => {
        throw new Error("EXDEV: rename failed");
      },
    };
    expect(() =>
      writeFileAtomic(path, "NEW", { mode: 0o600, dirMode: 0o700, now: NOW, fs }),
    ).toThrow("EXDEV");
    expect(readFileSync(path, "utf8")).toBe("OLD");
    expect(readdirSync(dir).filter((n) => n.endsWith(".tmp"))).toEqual([]);
  });

  test("a failed temp write leaves the old file intact", () => {
    const dir = temp();
    const path = join(dir, "settings.json");
    writeFileSync(path, "OLD");
    const fs: InstallFs = {
      ...NODE_INSTALL_FS,
      writeFile: (p, data, m) => {
        if (p.endsWith(".tmp")) throw new Error("ENOSPC");
        NODE_INSTALL_FS.writeFile(p, data, m);
      },
    };
    expect(() =>
      writeFileAtomic(path, "NEW", { mode: 0o600, dirMode: 0o700, now: NOW, fs }),
    ).toThrow("ENOSPC");
    expect(readFileSync(path, "utf8")).toBe("OLD");
  });
});

describe("NODE_INSTALL_FS and removeFile", () => {
  test("readFile is null for a missing file and throws on a directory", () => {
    const dir = temp();
    expect(NODE_INSTALL_FS.readFile(join(dir, "missing"))).toBeNull();
    expect(() => NODE_INSTALL_FS.readFile(dir)).toThrow();
  });

  test("removeFile removes a file and ignores a missing one", () => {
    const dir = temp();
    const path = join(dir, "x");
    writeFileSync(path, "1");
    removeFile(path, NODE_INSTALL_FS);
    removeFile(path, NODE_INSTALL_FS);
    expect(NODE_INSTALL_FS.exists(path)).toBe(false);
  });
});
