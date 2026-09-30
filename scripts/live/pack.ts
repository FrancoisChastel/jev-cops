#!/usr/bin/env bun
/**
 * `bun scripts/live/pack.ts <dir>`: packs every publishable package with the release
 * tooling (`scripts/pack-lib.ts`: `bun pm pack`, then the tarball rules) into
 * `<dir>/tarballs/`, and writes `<dir>/tarballs/manifest.json` (`{ version, tarballs: {
 * name: file } }`), the build context the live images install jev-cops from
 * (`docker/files/install-jev-cops.sh`). Exits 1 when a tarball breaks a rule: the images
 * must hold exactly what a release would publish.
 */
import { copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { type PackedPackage, packAll } from "../pack-lib.ts";

/** What `manifest.json` holds. */
export interface LiveManifest {
  readonly version: string;
  readonly tarballs: Readonly<Record<string, string>>;
}

/** The manifest for packed packages (file names only: the dir travels as a whole). */
export function manifestOf(packed: readonly PackedPackage[]): LiveManifest {
  const version = packed.find((p) => p.pkg.manifest.name === "jev-cops")?.unpacked.manifest.version;
  if (version === undefined) throw new Error("the jev-cops package was not packed");
  const tarballs = Object.fromEntries(packed.map((p) => [p.pkg.manifest.name, basename(p.tgz)]));
  return { version, tarballs };
}

/** Every rule a tarball broke, one line each (empty: all clean). */
export function problemLines(packed: readonly PackedPackage[]): string[] {
  return packed.flatMap((p) => p.problems.map((why) => `${p.pkg.manifest.name}: ${why}`));
}

/** Packs into `<dir>/work`, copies the tarballs into `<dir>/tarballs` with the manifest. */
export async function packForLive(
  dir: string,
  pack: (dest: string) => Promise<PackedPackage[]> = (dest) => packAll(dest),
): Promise<{ manifest: LiveManifest; problems: string[] }> {
  const packed = await pack(join(dir, "work"));
  const problems = problemLines(packed);
  const out = join(dir, "tarballs");
  mkdirSync(out, { recursive: true });
  for (const p of packed) copyFileSync(p.tgz, join(out, basename(p.tgz)));
  const manifest = manifestOf(packed);
  writeFileSync(join(out, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  return { manifest, problems };
}

/** The command line; resolves with the exit code (2 usage, 1 a rule broken, 0 packed). */
export async function runPackCli(
  argv: readonly string[],
  write: (fd: 1 | 2, text: string) => void,
  pack?: (dest: string) => Promise<PackedPackage[]>,
): Promise<number> {
  const dir = argv[0];
  if (dir === undefined) {
    write(2, "usage: bun scripts/live/pack.ts <dir>\n");
    return 2;
  }
  const { manifest, problems } = await packForLive(resolve(dir), pack);
  for (const [name, file] of Object.entries(manifest.tarballs))
    write(1, `packed ${name} → ${file}\n`);
  for (const line of problems) write(2, `tarball rule broken: ${line}\n`);
  return problems.length === 0 ? 0 : 1;
}

if (import.meta.main) {
  const write = (fd: 1 | 2, text: string) =>
    (fd === 1 ? process.stdout : process.stderr).write(text);
  process.exit(await runPackCli(process.argv.slice(2), write));
}
