# Releasing jev-cops

jev-cops ships to npm as ten packages that move in lockstep: one version for all of them.
Users install one of them:

```bash
bun add -g jev-cops        # or: npm install -g jev-cops, with bun on PATH
```

| Package | Directory | What it is |
|---|---|---|
| `@jev-cops/core` | `packages/core` | event schema, bash normalizer (tree-sitter WASM), context and policy engines |
| `@jev-cops/sdk` | `packages/sdk` | `definePolicy`, typed questions, fixture runner (policy authors import it) |
| `@jev-cops/judge` | `packages/judge` | semantic judge providers |
| `@jev-cops/policies` | `policies` | the starter policies, their `_lib/` helpers and fixtures |
| `@jev-cops/openshell` | `packages/openshell` | the OpenShell policy compiler and `openshell` wrapper (reads `@jev-cops/policies/_lib/config-trees`) |
| `@jev-cops/daemon` | `packages/daemon` | `copsd`; defaults to the installed `@jev-cops/policies` |
| `@jev-cops/adapter-claude-code` | `adapters/claude-code` | `cops-hook` |
| `@jev-cops/adapter-pi` | `adapters/pi` | the Pi extension |
| `@jev-cops/cli` | `packages/cli` | `cops` |
| `jev-cops` | `packages/jev-cops` | the package users install: bins `cops`, `copsd`, `cops-hook` |

The packages ship TypeScript sources and run on Bun only (D-007). The compiled binaries
(`bun run build`) are a separate artifact and are not published to npm.

## One-time setup (owner)

1. **npm account with 2FA** set to "authorization and writes".
2. **Create the npm organization `jev-cops`** (npmjs.com → Add Organization, free plan for
   public packages). It owns the `@jev-cops` scope; without it the first scoped publish
   fails with 404/403.
3. **Check the unscoped name.** `jev-cops` returned 404 on 2026-09-30 (free). npm also
   refuses names too similar to existing ones; only the first publish tells.
4. **Make the GitHub repository public before the first release.** npm provenance is
   refused for private repositories.
5. **Create the `NPM_TOKEN` secret.** On npmjs.com create a granular access token with
   read and write on all packages of the `jev-cops` org and on `jev-cops` (a token scoped to
   named packages cannot be made before the packages exist; narrow it after the first
   release). In GitHub: Settings → Environments → create `npm` (add yourself as a required
   reviewer), then add the token as the environment secret `NPM_TOKEN`. The release job runs
   in that environment.
6. Optional, after the first release: switch to **npm trusted publishing** (each package's
   settings on npmjs.com → Trusted publisher → GitHub Actions, this repository, workflow
   `release.yml`, environment `npm`). It needs npm ≥ 11.5.1 in the job; then remove
   `NPM_TOKEN`.

## Every release

1. **Start from a green master.** `git switch master && git pull`; CI must be green.
2. **Bump the version, in lockstep.**

   ```bash
   bun run version:set 0.2.0     # every publishable package.json; the root stays private
   bun install                   # refresh bun.lock
   ```

   Internal dependencies stay `workspace:*` in the repository; `bun pm pack` pins them to
   the exact version in each tarball. Move `CHANGELOG.md`'s `[Unreleased]` section to
   `[0.2.0] - <date>`. Commit: `chore: release 0.2.0`.
3. **Check locally.**

   ```bash
   bun run check            # lint, typecheck, tests (the tarball rules run here too)
   bun run gate             # every starter policy against its fixtures
   bun run pack:smoke       # pack, install globally in a temp HOME, run cops/copsd/cops-hook
   bun run release:dry-run  # every npm publish --dry-run, in publish order
   ```

4. **Push**, and optionally tag: `git tag v0.2.0 && git push origin v0.2.0` (a tag does not
   publish anything).
5. **Run the workflow.** GitHub → Actions → Release → Run workflow on `master`:
   dist-tag `latest` (or `next` for a prerelease such as `0.2.0-rc.1`), `dry_run` checked.
   Read the log, then run it again with `dry_run` unchecked and approve the `npm`
   environment. The job runs `bun run check`, `bun run gate`, `bun run pack:smoke`, then
   `scripts/release.ts --publish --tag <tag>`.
6. **Verify.**

   ```bash
   npm view jev-cops@0.2.0 dependencies
   npm view @jev-cops/core dist-tags
   bun add -g jev-cops@0.2.0 && cops --version && cops doctor
   ```

   Each package page on npmjs.com shows a provenance badge linking to the workflow run.

## How publishing works

`scripts/release.ts` packs each package with `bun pm pack` (npm would leave
`workspace:*` in the manifest; never run `npm publish` or `npm pack` in a package
directory), checks the tarball (`scripts/pack-lib.ts`), then publishes it with
`npm publish <tarball> --access public --tag <tag>`. npm, not Bun, uploads: `bun publish`
has no provenance option. Provenance comes from each manifest's
`publishConfig.provenance` and the job's `id-token: write`.

**Publish order:** core → sdk → judge → policies → openshell → daemon → adapters
(claude-code, pi) → cli → jev-cops. Each package goes after its dependencies, so a user never resolves a
version that is not on the registry yet. The order is `PUBLISH_ORDER` in
`scripts/pack-lib.ts`; a test fails when a workspace package is missing from it or comes
before a dependency.

**A release that stops halfway** (network, a refused package) can be run again: versions
already on the registry are skipped. Never unpublish (npm allows it only within 72 hours,
and the version can never be reused); publish a fixed patch and deprecate the broken one:
`npm deprecate jev-cops@0.2.0 "broken hook; use 0.2.1"` (repeat for each package).

**Dist-tags.** `latest` is what `bun add -g jev-cops` installs. Prereleases go out as
`X.Y.Z-rc.N` on `next`. To move a tag, do it for all ten packages:
`npm dist-tag add @jev-cops/core@0.2.0 latest` (and so on, then `jev-cops@0.2.0`).

## Known install caveats

- The bins start with `#!/usr/bin/env bun`: `bun` must be on the `PATH` of the shell and of
  the environment Claude Code runs hooks with. `cops install claude-code` runs the hook
  with `--version` and a canary before it writes anything, so a missing `bun` is caught.
- Bun installs package bins mode 0777. `cops install claude-code` warns when the hook is
  writable by other users and prints the `chmod go-w` to run.
- `npm install -g jev-cops` runs `tree-sitter-bash`'s install script (`node-gyp-build`,
  with prebuilt binaries for macOS, Linux and Windows on x64 and arm64). jev-cops only uses
  the package's WASM grammar, so `--ignore-scripts` is safe where that script fails. Bun
  skips it by default.
- Installed from npm, copsd protects `node_modules/@jev-cops/` and
  `node_modules/jev-cops/` like its other inputs: the hook loads that code on every call.

## Adding a package

A new package (shown with `@jev-cops/openshell` in `packages/openshell`, the last one
added) must:

- use this manifest shape (the tarball rules in `scripts/pack-lib.ts` enforce it):

  ```json
  {
    "name": "@jev-cops/openshell",
    "version": "<the current lockstep version>",
    "description": "<one sentence>",
    "keywords": ["jev-cops", "coding-agents", "ai-agents", "agent-security", "guardrails", "bun"],
    "homepage": "https://github.com/FrancoisChastel/jev-cops#readme",
    "bugs": { "url": "https://github.com/FrancoisChastel/jev-cops/issues" },
    "license": "Apache-2.0",
    "author": "François Chastel (https://github.com/FrancoisChastel)",
    "repository": {
      "type": "git",
      "url": "git+https://github.com/FrancoisChastel/jev-cops.git",
      "directory": "packages/openshell"
    },
    "type": "module",
    "main": "./src/index.ts",
    "types": "./src/index.ts",
    "exports": { ".": "./src/index.ts", "./package.json": "./package.json" },
    "files": ["src", "!src/**/*.test.ts", "!src/testing", "README.md", "LICENSE"],
    "sideEffects": false,
    "engines": { "bun": ">=1.3.0" },
    "publishConfig": { "access": "public", "provenance": true },
    "dependencies": { "@jev-cops/core": "workspace:*" }
  }
  ```

  A `bin` entry points at a file whose first line is `#!/usr/bin/env bun`, and that file
  is listed in `sideEffects` instead of `false`.
- carry a `README.md` and a copy of the root `LICENSE`;
- import only what it declares (the tarball rules check every import);
- be added to `PUBLISH_ORDER` after its dependencies, and to the `jev-cops` package's
  dependencies if users need it installed.
