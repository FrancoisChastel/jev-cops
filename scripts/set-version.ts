#!/usr/bin/env bun
/**
 * `bun run version:set <x.y.z>`: the lockstep bump. Sets the version of every publishable
 * package (`scripts/pack-lib.ts` PUBLISH_ORDER); the root package stays private and
 * unversioned. See RELEASING.md.
 */
import { setLockstepVersion } from "./pack-lib.ts";

const version = process.argv[2];
if (version === undefined || process.argv.length > 3) {
  process.stderr.write("usage: bun run version:set <x.y.z>\n");
  process.exit(2);
}
try {
  const changed = setLockstepVersion(version);
  for (const path of changed) process.stdout.write(`${path}\n`);
  process.stdout.write(`${changed.length} manifest(s) set to ${version}; run bun install\n`);
} catch (cause) {
  process.stderr.write(`version:set: ${cause instanceof Error ? cause.message : String(cause)}\n`);
  process.exit(1);
}
