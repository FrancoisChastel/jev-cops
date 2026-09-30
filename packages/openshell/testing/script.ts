/**
 * Executable test doubles: a Bun script with an absolute shebang (the running Bun), so it
 * runs under a scrubbed environment where `bun` is not on PATH.
 */
import { chmodSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** Writes `source` as an executable Bun script `dir/name`; returns its absolute path. */
export function writeBunScript(dir: string, name: string, source: string): string {
  const path = join(dir, name);
  writeFileSync(path, `#!${process.execPath}\n${source}`);
  chmodSync(path, 0o755);
  return path;
}
