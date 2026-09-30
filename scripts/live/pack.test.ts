import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PackedPackage } from "../pack-lib.ts";
import { manifestOf, packForLive, problemLines, runPackCli } from "./pack.ts";

function fakePacked(dir: string, name: string, problems: string[] = []): PackedPackage {
  const file = `${name.replace("@", "").replace("/", "-")}-0.1.0.tgz`;
  const tgz = join(dir, file);
  writeFileSync(tgz, name);
  return {
    pkg: { dir: "x", manifest: { name, version: "0.1.0" } },
    tgz,
    unpacked: { root: dir, files: [], manifest: { name, version: "0.1.0" } },
    problems,
  };
}

describe("live pack", () => {
  test("manifest maps every package to its tarball file; version from jev-cops", () => {
    const dir = mkdtempSync(join(tmpdir(), "live-pack-"));
    const packed = [fakePacked(dir, "@jev-cops/core"), fakePacked(dir, "jev-cops")];
    expect(manifestOf(packed)).toEqual({
      version: "0.1.0",
      tarballs: { "@jev-cops/core": "jev-cops-core-0.1.0.tgz", "jev-cops": "jev-cops-0.1.0.tgz" },
    });
    expect(() => manifestOf([packed[0] as PackedPackage])).toThrow("jev-cops package");
  });

  test("problem lines name the package", () => {
    const dir = mkdtempSync(join(tmpdir(), "live-pack-"));
    expect(problemLines([fakePacked(dir, "@jev-cops/core", ["missing README.md"])])).toEqual([
      "@jev-cops/core: missing README.md",
    ]);
  });

  test("packForLive copies the tarballs and writes manifest.json", async () => {
    const dir = mkdtempSync(join(tmpdir(), "live-pack-"));
    const src = join(dir, "src");
    mkdirSync(src);
    const result = await packForLive(dir, async (dest) => {
      expect(dest).toBe(join(dir, "work"));
      return [fakePacked(src, "@jev-cops/core", ["bad"]), fakePacked(src, "jev-cops")];
    });
    expect(result.problems).toEqual(["@jev-cops/core: bad"]);
    expect(existsSync(join(dir, "tarballs", "jev-cops-0.1.0.tgz"))).toBe(true);
    const written = JSON.parse(readFileSync(join(dir, "tarballs", "manifest.json"), "utf8"));
    expect(written).toEqual(result.manifest);
  });

  test("the command line: usage, clean pack, broken rule", async () => {
    const out: string[] = [];
    const write = (fd: 1 | 2, text: string) => {
      out.push(`${fd}:${text}`);
    };
    expect(await runPackCli([], write)).toBe(2);
    const dir = mkdtempSync(join(tmpdir(), "live-pack-"));
    const clean = async () => [fakePacked(dir, "jev-cops")];
    expect(await runPackCli([join(dir, "a")], write, clean)).toBe(0);
    const broken = async () => [fakePacked(dir, "jev-cops", ["no LICENSE"])];
    expect(await runPackCli([join(dir, "b")], write, broken)).toBe(1);
    expect(out).toEqual([
      "2:usage: bun scripts/live/pack.ts <dir>\n",
      "1:packed jev-cops → jev-cops-0.1.0.tgz\n",
      "1:packed jev-cops → jev-cops-0.1.0.tgz\n",
      "2:tarball rule broken: jev-cops: no LICENSE\n",
    ]);
  });
});
