#!/bin/bash
# Installs jev-cops the way a user does (`bun add -g jev-cops`), from the tarballs that
# `scripts/live/pack.ts` packed from this repository: nothing is published, so every
# `@jev-cops/*` dependency resolves to its local tarball through `overrides` in Bun's
# global package.json (as scripts/pack-smoke.ts does). Third-party dependencies come from
# the npm registry: this runs during `docker build`, the only step with network access.
set -euo pipefail

tarballs=${1:-/opt/jev-cops-live/tarballs}
manifest="$tarballs/manifest.json"
global="$BUN_INSTALL/install/global"
mkdir -p "$global"

# shellcheck disable=SC2016 # a JavaScript program: its ${…} are template literals
bun -e '
  const [manifest, dir, out] = process.argv.slice(1);
  const packed = JSON.parse(await Bun.file(manifest).text());
  const overrides = Object.fromEntries(
    Object.entries(packed.tarballs)
      .filter(([name]) => name !== "jev-cops")
      .map(([name, file]) => [name, `${dir}/${file}`]),
  );
  await Bun.write(out, JSON.stringify({ overrides }, null, 2));
  console.log(`${dir}/${packed.tarballs["jev-cops"]}`);
' "$manifest" "$tarballs" "$global/package.json" > /tmp/jev-cops-meta
bun add -g "$(cat /tmp/jev-cops-meta)"
rm -f /tmp/jev-cops-meta
cops --version
