#!/usr/bin/env bun
/**
 * Publishes every jev-cops package in order. It never publishes unless told to:
 *
 *   bun run release:dry-run                       every `npm publish --dry-run`, in order
 *   bun scripts/release.ts --publish --tag latest the release workflow's real publish
 *
 * Each package is packed with `bun pm pack` (which pins `workspace:*` to the release
 * version; npm would not) and checked (`scripts/pack-lib.ts`), then the tarball goes to
 * `npm publish <tgz> --access public --tag <tag>`. Provenance comes from each manifest's
 * `publishConfig.provenance`: npm signs it in GitHub Actions with `id-token: write`. A
 * version already on the registry is skipped, so a release that stopped halfway can be
 * run again. The logic is in `release-lib.ts`; see RELEASING.md.
 */
import { packAll } from "./pack-lib.ts";
import { runRelease } from "./release-lib.ts";

async function onRegistry(id: string): Promise<boolean> {
  const proc = Bun.spawn(["npm", "view", id, "version"], { stdout: "pipe", stderr: "ignore" });
  const [code, out] = await Promise.all([proc.exited, new Response(proc.stdout).text()]);
  return code === 0 && out.trim() !== "";
}

const code = await runRelease(process.argv.slice(2), {
  pack: (dir) => packAll(dir),
  onRegistry,
  exec: (argv) => Bun.spawn([...argv], { stdout: "inherit", stderr: "inherit" }).exited,
  out: (line) => process.stdout.write(`\n${line}\n`),
  err: (line) => process.stderr.write(`${line}\n`),
});
process.exit(code);
