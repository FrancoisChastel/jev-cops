import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  entryProblems,
  fileListProblems,
  importProblems,
  type Manifest,
  manifestProblems,
  metaPackageProblems,
  NOT_IN_META,
  type PackedPackage,
  PUBLISH_ORDER,
  packAll,
  packageOf,
  publishable,
  publishOrderProblems,
  REPO,
  REPO_URL,
  releaseVersion,
  secretProblems,
  setLockstepVersion,
  type TarballInput,
  tarballProblems,
  type Unpacked,
  type WorkspacePackage,
  workspacePackages,
} from "./pack-lib.ts";

/**
 * Every publishable package is packed with `bun pm pack` (what `bun publish` uploads) and
 * its tarball checked: file list, manifest, entries, imports, secrets. No network; the
 * install-and-run half is `bun run pack:smoke`.
 */
let dir: string;
let packed: PackedPackage[];
const byName = (name: string) => {
  const p = packed.find((x) => x.pkg.manifest.name === name);
  if (p === undefined) throw new Error(`${name} was not packed`);
  return p;
};

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "jev-cops-pack-"));
  packed = await packAll(dir);
}, 60_000);
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("the packed tarballs", () => {
  test("every publishable package, in publish order, with no problem", () => {
    expect(packed.map((p) => p.pkg.manifest.name)).toEqual([...PUBLISH_ORDER]);
    expect(Object.fromEntries(packed.map((p) => [p.pkg.manifest.name, p.problems]))).toEqual(
      Object.fromEntries(PUBLISH_ORDER.map((n) => [n, []])),
    );
  });

  test("workspace:* dependencies are pinned to the release version by the pack", () => {
    const version = releaseVersion(workspacePackages());
    const meta = byName("jev-cops").unpacked.manifest;
    expect(meta.dependencies).toEqual({
      "@jev-cops/adapter-claude-code": version,
      "@jev-cops/adapter-pi": version,
      "@jev-cops/cli": version,
      "@jev-cops/daemon": version,
      "@jev-cops/openshell": version,
      "@jev-cops/policies": version,
      "@jev-cops/sdk": version,
    });
    expect(byName("@jev-cops/daemon").unpacked.manifest.dependencies?.["@jev-cops/policies"]).toBe(
      version,
    );
    expect(byName("@jev-cops/cli").unpacked.manifest.dependencies?.["@jev-cops/openshell"]).toBe(
      version,
    );
  });

  test("openshell reads config-tamper's trees through the policies package, not a path", () => {
    const openshell = byName("@jev-cops/openshell").unpacked;
    expect(openshell.manifest.dependencies?.["@jev-cops/policies"]).toBe(
      releaseVersion(workspacePackages()),
    );
    expect(byName("@jev-cops/policies").unpacked.manifest.exports).toEqual({
      "./_lib/config-trees": "./_lib/config-trees.ts",
      "./package.json": "./package.json",
    });
    expect(openshell.files.filter((f) => !f.startsWith("src/"))).toEqual([
      "LICENSE",
      "README.md",
      "package.json",
    ]);
  });

  test("the policies ship with their fixtures and helpers, not their tests", () => {
    const files = byName("@jev-cops/policies").unpacked.files;
    expect(files).toContain("config-tamper.ts");
    expect(files).toContain("config-tamper.fixtures.json");
    expect(files.some((f) => f.startsWith("_lib/"))).toBe(true);
    expect(files.some((f) => f.includes(".test."))).toBe(false);
  });

  test("the jev-cops package is its three bins, a README and the LICENSE", () => {
    expect(byName("jev-cops").unpacked.files).toEqual([
      "LICENSE",
      "README.md",
      "bin/cops-hook.ts",
      "bin/cops.ts",
      "bin/copsd.ts",
      "package.json",
    ]);
  });

  test("test helpers stay home: no testing/, no judge contract suite", () => {
    const all = packed.flatMap((p) => p.unpacked.files);
    expect(all.filter((f) => f.includes("testing/") || f.endsWith("contract.ts"))).toEqual([]);
    expect(byName("@jev-cops/adapter-pi").unpacked.files).toContain("pi-types.ts");
  });
});

describe("publish order", () => {
  const pkg = (name: string, deps: Record<string, string> = {}, extra = {}): WorkspacePackage => ({
    dir: `packages/${name}`,
    manifest: { name, version: "1.0.0", dependencies: deps, ...extra },
  });

  test("the real workspace is consistent", () => {
    expect(publishOrderProblems(workspacePackages())).toEqual([]);
  });

  test("an unlisted package, a missing one, a private one and a dependency published later", () => {
    const pkgs = [
      pkg("a", { b: "workspace:*" }),
      pkg("b"),
      pkg("new"),
      pkg("p", {}, { private: true }),
    ];
    expect(publishOrderProblems(pkgs, ["a", "b", "gone", "p"])).toEqual([
      "new (packages/new) is not in PUBLISH_ORDER (scripts/pack-lib.ts)",
      "gone is not a workspace package",
      "a is published before its dependency b",
      "p is private",
    ]);
  });

  test("publishable keeps the listed packages in order; releaseVersion needs jev-cops", () => {
    const pkgs = [pkg("jev-cops"), pkg("@jev-cops/core"), pkg("other")];
    expect(publishable(pkgs).map((p) => p.manifest.name)).toEqual(["@jev-cops/core", "jev-cops"]);
    expect(releaseVersion(pkgs)).toBe("1.0.0");
    expect(() => releaseVersion([pkg("other")])).toThrow("no jev-cops package");
  });
});

describe("what `bun add -g jev-cops` installs", () => {
  const pkg = (name: string, deps: Record<string, string> = {}): WorkspacePackage => ({
    dir: `packages/${name}`,
    manifest: { name, version: "1.0.0", dependencies: deps },
  });

  test("every published package is installed with jev-cops, except those NOT_IN_META names", () => {
    expect(metaPackageProblems(workspacePackages())).toEqual([]);
    // Nothing installed imports the scanner yet: the daemon wires it in at PLAN-SETUP S2.
    expect(Object.keys(NOT_IN_META)).toEqual(["@jev-cops/scanner"]);
    const meta = workspacePackages().find((p) => p.manifest.name === "jev-cops");
    expect(meta?.manifest.dependencies).not.toHaveProperty("@jev-cops/scanner");
  });

  test("a package nothing installs, and a NOT_IN_META entry that is installed after all", () => {
    const pkgs = [
      pkg("jev-cops", { "@jev-cops/a": "workspace:*" }),
      pkg("@jev-cops/a", { "@jev-cops/b": "workspace:*" }),
      pkg("@jev-cops/b"),
      pkg("@jev-cops/lonely"),
      pkg("@jev-cops/standalone"),
    ];
    const order = pkgs.map((p) => p.manifest.name);
    expect(
      metaPackageProblems(pkgs, order, { "@jev-cops/standalone": "why", "@jev-cops/b": "old" }),
    ).toEqual([
      "@jev-cops/lonely is published but jev-cops does not install it: add it to the jev-cops package's dependencies, or to NOT_IN_META (scripts/pack-lib.ts) with the reason",
      "@jev-cops/b is in NOT_IN_META but jev-cops installs it (through @jev-cops/a): drop it from NOT_IN_META",
    ]);
    expect(metaPackageProblems([pkg("x")], ["x"], {})).toEqual([
      "no jev-cops package in the workspace",
    ]);
  });
});

describe("the rules catch what must not ship", () => {
  let root: string;
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "jev-cops-rules-"));
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  function tarball(files: Record<string, string>, manifest: Partial<Manifest> = {}): Unpacked {
    const at = mkdtempSync(join(root, "t-"));
    const full: Manifest = { name: "@jev-cops/x", version: "1.0.0", ...manifest };
    const all = { ...files, "package.json": JSON.stringify(full) };
    for (const [file, text] of Object.entries(all)) {
      mkdirSync(dirname(join(at, file)), { recursive: true });
      writeFileSync(join(at, file), text);
    }
    return { root: at, files: Object.keys(all).sort(), manifest: full };
  }

  test("file list: README and LICENSE required; tests, helpers, builds, stores and keys refused", () => {
    const files = [
      "package.json",
      "src/a.test.ts",
      "src/testing/double.ts",
      "dist/cops",
      "node_modules/x/index.js",
      ".env.local",
      ".npmrc",
      "keys/id_ed25519",
      "audit.jsonl",
      "cops.sqlite",
    ];
    const problems = fileListProblems("@jev-cops/x", files);
    expect(problems.slice(0, 2)).toEqual(["missing README.md", "missing LICENSE"]);
    expect(problems).toHaveLength(2 + files.length - 1);
  });

  test("fixtures: only the policies' own, at their top level", () => {
    expect(fileListProblems("@jev-cops/policies", ["a.fixtures.json"])).not.toContain(
      "a.fixtures.json: fixtures ship only as the policies' own *.fixtures.json",
    );
    expect(fileListProblems("@jev-cops/policies", ["_lib/a.fixtures.json"])).toContain(
      "_lib/a.fixtures.json: fixtures ship only as the policies' own *.fixtures.json",
    );
    expect(fileListProblems("@jev-cops/core", ["a.fixtures.json"])).toContain(
      "a.fixtures.json: fixtures ship only as the policies' own *.fixtures.json",
    );
  });

  test("manifest: a leftover workspace range, a loose internal pin, missing metadata", () => {
    const unpacked = tarball(
      {},
      {
        private: true,
        version: "0.9.0",
        dependencies: { "@jev-cops/core": "workspace:*", "@jev-cops/sdk": "^1.0.0", zod: "^4" },
      },
    );
    const input: TarballInput = {
      pkg: { dir: "packages/x", manifest: { name: "@jev-cops/y", version: "1.0.0" } },
      unpacked,
      version: "1.0.0",
      internal: new Set(["@jev-cops/core", "@jev-cops/sdk"]),
      license: "L",
    };
    expect(manifestProblems(input)).toEqual([
      "name @jev-cops/x ≠ @jev-cops/y",
      "version 0.9.0 ≠ 1.0.0",
      'engines.bun must be ">=1.3.0"',
      "license must be Apache-2.0",
      'type must be "module"',
      "no files allow-list",
      `repository.url must be ${REPO_URL}`,
      "repository.directory must be packages/x",
      "no description",
      "no homepage",
      "no bugs",
      "no author",
      "no keywords",
      "private: true",
      "publishConfig.provenance must be true",
      'publishConfig.access must be "public" for a scoped package',
      "a workspace: range is left",
      "dependency @jev-cops/core@workspace:*: must be exactly 1.0.0",
      "dependency @jev-cops/sdk@^1.0.0: must be exactly 1.0.0",
    ]);
  });

  test("entries: missing targets and a bin without the Bun shebang", () => {
    const unpacked = tarball(
      { "bin/ok.ts": "#!/usr/bin/env bun\n", "bin/node.ts": "#!/usr/bin/env node\n" },
      {
        main: "./src/index.ts",
        exports: { ".": { import: "./src/index.ts" }, "./x/*": "./x/*.ts" },
        bin: { ok: "./bin/ok.ts", node: "./bin/node.ts", gone: "./bin/gone.ts" },
      },
    );
    expect(entryProblems(unpacked)).toEqual([
      "entry ./src/index.ts is not in the tarball",
      "entry ./src/index.ts is not in the tarball",
      "bin node: first line must be #!/usr/bin/env bun",
      "bin gone → ./bin/gone.ts is not in the tarball",
    ]);
  });

  test("imports: dangling relative, undeclared bare, bun:test outside the SDK adapter", () => {
    const unpacked = tarball(
      {
        "src/a.ts": [
          "#!/usr/bin/env bun",
          'import { b } from "./b.ts";',
          'import "./dir";',
          'import { c } from "./gone.ts";',
          'import { z } from "zod";',
          'import { q } from "@scope/pkg/deep";',
          'import { readFileSync } from "node:fs";',
          'import { join } from "path";',
          'import { $ } from "bun";',
          'import { test } from "bun:test";',
          'import self from "@jev-cops/x/sub";',
          "// import nothing from './commented.ts';",
          "export { b, c, z, q, readFileSync, join, $, test, self };",
        ].join("\n"),
        "src/b.ts": "export const b = 1;\n",
        "src/dir/index.ts": "export {};\n",
      },
      { dependencies: { zod: "^4" } },
    );
    expect(importProblems(unpacked)).toEqual([
      "src/a.ts: imports ./gone.ts, which is not in the tarball",
      "src/a.ts: imports undeclared @scope/pkg/deep",
      "src/a.ts: imports bun:test",
    ]);
    expect(packageOf("@scope/pkg/deep")).toBe("@scope/pkg");
    expect(packageOf("zod/v4")).toBe("zod");
  });

  test("secrets: key material and tokens in any shipped file", () => {
    const token = `ghp_${"a".repeat(36)}`;
    const unpacked = tarball({
      "README.md": `export GH=${token}\n`,
      "src/k.ts": "-----BEGIN OPENSSH PRIVATE KEY-----\n",
      "src/ok.ts": "const pattern = /AKIA[0-9A-Z]{16}/;\n",
    });
    expect(secretProblems(unpacked)).toEqual(["README.md: GitHub token", "src/k.ts: private key"]);
  });

  test("tarballProblems: a LICENSE that is not the repository's", () => {
    const unpacked = tarball({ LICENSE: "MIT", "README.md": "x" }, {});
    const input: TarballInput = {
      pkg: { dir: "packages/x", manifest: { name: "@jev-cops/x", version: "1.0.0" } },
      unpacked,
      version: "1.0.0",
      internal: new Set(),
      license: readFileSync(join(REPO, "LICENSE"), "utf8"),
    };
    expect(tarballProblems(input)).toContain("LICENSE differs from the repository's");
  });
});

describe("setLockstepVersion", () => {
  let repo: string;
  beforeAll(() => {
    repo = mkdtempSync(join(tmpdir(), "jev-cops-bump-"));
    const write = (path: string, json: object) => {
      mkdirSync(dirname(join(repo, path)), { recursive: true });
      writeFileSync(join(repo, path), `${JSON.stringify(json, null, 2)}\n`);
    };
    write("package.json", { name: "root", version: "0.0.0", private: true, workspaces: ["p/*"] });
    write("p/core/package.json", { name: "@jev-cops/core", version: "0.1.0" });
    write("p/meta/package.json", {
      name: "jev-cops",
      version: "0.1.0",
      dependencies: { "@jev-cops/core": "workspace:*" },
    });
    write("p/other/package.json", { name: "other", version: "9.9.9" });
  });
  afterAll(() => rmSync(repo, { recursive: true, force: true }));

  test("bumps every publishable manifest, nothing else, and is idempotent", () => {
    const changed = setLockstepVersion("0.2.0-rc.1", repo);
    expect(changed).toEqual([join(repo, "p/core/package.json"), join(repo, "p/meta/package.json")]);
    const meta = JSON.parse(readFileSync(join(repo, "p/meta/package.json"), "utf8"));
    expect(meta).toEqual({
      name: "jev-cops",
      version: "0.2.0-rc.1",
      dependencies: { "@jev-cops/core": "workspace:*" },
    });
    expect(JSON.parse(readFileSync(join(repo, "p/other/package.json"), "utf8")).version).toBe(
      "9.9.9",
    );
    expect(setLockstepVersion("0.2.0-rc.1", repo)).toEqual([]);
  });

  test("refuses what is not a version", () => {
    expect(() => setLockstepVersion("v0.2", repo)).toThrow("not a version: v0.2");
  });
});
