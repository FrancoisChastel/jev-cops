/**
 * What every published jev-cops tarball must look like, checked on the tarball itself (what
 * `bun pm pack` and `bun publish` produce), never on the source tree: the workspace
 * packages in publish order, packing, unpacking, and the file-list, manifest, import and
 * secret rules. Used by `scripts/pack-smoke.ts`, `scripts/release.ts` and their tests.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { isBuiltin } from "node:module";
import { dirname, join, normalize, resolve } from "node:path";

export const REPO = resolve(import.meta.dir, "..");
export const REPO_URL = "git+https://github.com/FrancoisChastel/jev-cops.git";
/** Every package runs on Bun only (D-007); this is the floor the manifests declare. */
export const BUN_ENGINE = ">=1.3.0";

/**
 * Publish order: every package after the packages it depends on. A workspace package that
 * is not listed here fails {@link publishOrderProblems}, so a new package cannot ship
 * without a place in the release.
 */
export const PUBLISH_ORDER: readonly string[] = [
  "@jev-cops/core",
  "@jev-cops/sdk",
  "@jev-cops/judge",
  "@jev-cops/scanner",
  "@jev-cops/policies",
  "@jev-cops/openshell",
  "@jev-cops/daemon",
  "@jev-cops/adapter-claude-code",
  "@jev-cops/adapter-pi",
  "@jev-cops/cli",
  "jev-cops",
];

/**
 * Published packages that `bun add -g jev-cops` does not install, each with the reason. Every
 * other published package must be reached from the `jev-cops` meta package through
 * dependencies ({@link metaPackageProblems}), so nothing ships to npm unused by accident, and
 * a package listed here that the meta package does reach is a problem too (a stale entry).
 */
export const NOT_IN_META: Readonly<Record<string, string>> = Object.freeze({
  "@jev-cops/scanner":
    "published for the setup track: nothing jev-cops installs imports it until the daemon wires it in (PLAN-SETUP S2); the meta package depends on it from then on",
});

/** The fields of a package.json the rules read. */
export interface Manifest {
  readonly name: string;
  readonly version: string;
  readonly private?: boolean;
  readonly description?: string;
  readonly keywords?: readonly string[];
  readonly license?: string;
  readonly author?: unknown;
  readonly homepage?: string;
  readonly bugs?: unknown;
  readonly type?: string;
  readonly main?: string;
  readonly types?: string;
  readonly bin?: Readonly<Record<string, string>>;
  readonly exports?: unknown;
  readonly files?: readonly string[];
  readonly engines?: Readonly<Record<string, string>>;
  readonly repository?: {
    readonly type?: string;
    readonly url?: string;
    readonly directory?: string;
  };
  readonly publishConfig?: { readonly access?: string; readonly provenance?: boolean };
  readonly dependencies?: Readonly<Record<string, string>>;
  readonly peerDependencies?: Readonly<Record<string, string>>;
  readonly optionalDependencies?: Readonly<Record<string, string>>;
}

/** A workspace package: its directory relative to the repo, and its manifest. */
export interface WorkspacePackage {
  readonly dir: string;
  readonly manifest: Manifest;
}

function readManifest(path: string): Manifest {
  return JSON.parse(readFileSync(path, "utf8")) as Manifest;
}

/** The directories a root `workspaces` entry names (`dir/*` or `dir`) that hold a package.json. */
function expandWorkspace(repo: string, pattern: string): string[] {
  if (!pattern.endsWith("/*"))
    return existsSync(join(repo, pattern, "package.json")) ? [pattern] : [];
  const parent = pattern.slice(0, -2);
  return readdirSync(join(repo, parent), { withFileTypes: true })
    .filter((e) => e.isDirectory() && existsSync(join(repo, parent, e.name, "package.json")))
    .map((e) => `${parent}/${e.name}`);
}

/** Every package of the root `workspaces`, private ones included, sorted by directory. */
export function workspacePackages(repo: string = REPO): WorkspacePackage[] {
  const root = readManifest(join(repo, "package.json")) as Manifest & { workspaces?: string[] };
  const dirs = (root.workspaces ?? []).flatMap((w) => expandWorkspace(repo, w)).sort();
  return dirs.map((dir) => ({ dir, manifest: readManifest(join(repo, dir, "package.json")) }));
}

/** The publishable packages in {@link PUBLISH_ORDER}; unlisted ones are left out. */
export function publishable(pkgs: readonly WorkspacePackage[]): WorkspacePackage[] {
  const byName = new Map(pkgs.map((p) => [p.manifest.name, p]));
  return PUBLISH_ORDER.flatMap((name) => {
    const p = byName.get(name);
    return p === undefined ? [] : [p];
  });
}

/** Unlisted or missing packages, private ones listed, and dependencies published later. */
export function publishOrderProblems(
  pkgs: readonly WorkspacePackage[],
  order: readonly string[] = PUBLISH_ORDER,
): string[] {
  const names = new Set(pkgs.map((p) => p.manifest.name));
  const problems = pkgs
    .filter((p) => p.manifest.private !== true && !order.includes(p.manifest.name))
    .map((p) => `${p.manifest.name} (${p.dir}) is not in PUBLISH_ORDER (scripts/pack-lib.ts)`);
  for (const name of order)
    if (!names.has(name)) problems.push(`${name} is not a workspace package`);
  for (const p of pkgs) {
    const at = order.indexOf(p.manifest.name);
    if (at >= 0 && p.manifest.private === true) problems.push(`${p.manifest.name} is private`);
    for (const dep of Object.keys(p.manifest.dependencies ?? {})) {
      const depAt = order.indexOf(dep);
      if (at >= 0 && names.has(dep) && depAt > at) {
        problems.push(`${p.manifest.name} is published before its dependency ${dep}`);
      }
    }
  }
  return problems;
}

/** Each package the meta package installs, with the package that pulls it in. */
function installedBy(
  pkgs: readonly WorkspacePackage[],
  meta: WorkspacePackage,
): Map<string, string> {
  const byName = new Map(pkgs.map((p) => [p.manifest.name, p]));
  const via = new Map<string, string>([[meta.manifest.name, meta.manifest.name]]);
  const queue = [meta];
  for (let p = queue.shift(); p !== undefined; p = queue.shift()) {
    for (const dep of Object.keys(p.manifest.dependencies ?? {})) {
      const next = byName.get(dep);
      if (next === undefined || via.has(dep)) continue;
      via.set(dep, p.manifest.name);
      queue.push(next);
    }
  }
  return via;
}

/**
 * Published packages the `jev-cops` meta package does not install that {@link NOT_IN_META}
 * does not name, and names in it that the meta package installs after all.
 */
export function metaPackageProblems(
  pkgs: readonly WorkspacePackage[],
  order: readonly string[] = PUBLISH_ORDER,
  standalone: Readonly<Record<string, string>> = NOT_IN_META,
): string[] {
  const meta = pkgs.find((p) => p.manifest.name === "jev-cops");
  if (meta === undefined) return ["no jev-cops package in the workspace"];
  const via = installedBy(pkgs, meta);
  const problems = order
    .filter((name) => !via.has(name) && !Object.hasOwn(standalone, name))
    .map(
      (name) =>
        `${name} is published but jev-cops does not install it: add it to the jev-cops package's dependencies, or to NOT_IN_META (scripts/pack-lib.ts) with the reason`,
    );
  for (const name of Object.keys(standalone)) {
    const parent = via.get(name);
    if (parent !== undefined) {
      problems.push(
        `${name} is in NOT_IN_META but jev-cops installs it (through ${parent}): drop it from NOT_IN_META`,
      );
    }
  }
  return problems;
}

/** The version every publishable package must carry: the `jev-cops` package's. */
export function releaseVersion(pkgs: readonly WorkspacePackage[]): string {
  const meta = pkgs.find((p) => p.manifest.name === "jev-cops");
  if (meta === undefined) throw new Error("no jev-cops package in the workspace");
  return meta.manifest.version;
}

/** A semver version (with an optional prerelease). */
const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
/** The top-level `"version"` line of a two-space-indented package.json. */
const VERSION_LINE = /^ {2}"version": "[^"]*"/m;

/**
 * Sets `version` in every publishable package.json (the lockstep bump; internal
 * dependencies stay `workspace:*` and are pinned at pack time). Returns the files changed.
 */
export function setLockstepVersion(version: string, repo: string = REPO): string[] {
  if (!SEMVER.test(version)) throw new Error(`not a version: ${version}`);
  const changed: string[] = [];
  for (const pkg of publishable(workspacePackages(repo))) {
    const path = join(repo, pkg.dir, "package.json");
    const text = readFileSync(path, "utf8");
    const next = text.replace(VERSION_LINE, `  "version": "${version}"`);
    if (next === text) continue;
    writeFileSync(path, next);
    changed.push(path);
  }
  return changed;
}

async function run(argv: string[], cwd: string): Promise<string> {
  const proc = Bun.spawn(argv, { cwd, stdout: "pipe", stderr: "pipe", stdin: "ignore" });
  const [code, out, err] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  if (code !== 0) throw new Error(`${argv.join(" ")} (in ${cwd}) exited ${code}: ${err.trim()}`);
  return out;
}

/**
 * `bun pm pack` of one package into `dest`; returns the tarball's path. Bun rewrites
 * `workspace:*` dependencies to the exact version (npm pack would not).
 */
export async function pack(
  pkg: WorkspacePackage,
  dest: string,
  repo: string = REPO,
): Promise<string> {
  mkdirSync(dest, { recursive: true });
  const out = await run(
    ["bun", "pm", "pack", "--quiet", "--destination", dest],
    join(repo, pkg.dir),
  );
  const tgz = out.trim().split("\n").at(-1) ?? "";
  if (!tgz.endsWith(".tgz") || !existsSync(tgz)) throw new Error(`bun pm pack printed "${out}"`);
  return tgz;
}

/** A tarball extracted into `into`: its files (relative, sorted) and its package.json. */
export interface Unpacked {
  readonly root: string;
  readonly files: readonly string[];
  readonly manifest: Manifest;
}

/** Extracts `tgz` into `into` (npm tarballs hold everything under `package/`). */
export async function unpack(tgz: string, into: string): Promise<Unpacked> {
  mkdirSync(into, { recursive: true });
  const listing = await run(["tar", "-tzf", tgz], into);
  await run(["tar", "-xzf", tgz], into);
  const files = listing
    .split("\n")
    .filter((l) => l.startsWith("package/") && !l.endsWith("/"))
    .map((l) => l.slice("package/".length))
    .sort();
  const root = join(into, "package");
  return { root, files, manifest: readManifest(join(root, "package.json")) };
}

/** What the rules need to judge one tarball. */
export interface TarballInput {
  readonly pkg: WorkspacePackage;
  readonly unpacked: Unpacked;
  readonly version: string;
  /** Names of every workspace package (internal dependencies). */
  readonly internal: ReadonlySet<string>;
  /** The repository's LICENSE text; each tarball carries the same. */
  readonly license: string;
}

const REQUIRED_FILES = ["package.json", "README.md", "LICENSE"];
/** Nothing a user runs: tests, test helpers, build output, installs, logs, stores, secrets. */
const FORBIDDEN: ReadonlyArray<readonly [RegExp, string]> = [
  [/\.test\.[cm]?[jt]sx?$/, "a test file"],
  [/(^|\/)(testing|testdata|__tests__|fixtures)\//, "a test helper directory"],
  [/(^|\/)node_modules\//, "node_modules"],
  [/(^|\/)(dist|coverage)\//, "build or coverage output"],
  [/(^|\/)\.env(\.|$)|(^|\/)\.npmrc$/, "an environment or registry credentials file"],
  [/\.(pem|key|p12)$|(^|\/)id_(rsa|ecdsa|ed25519)/, "a key file"],
  [/\.(sqlite|sqlite-journal|jsonl|log|tgz)$|\.DS_Store$/, "a store, log or archive"],
];
/** Tokens that must never ship (the core's secret detector covers more at run time). */
const SECRETS: ReadonlyArray<readonly [RegExp, string]> = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, "private key"],
  [/\bAKIA[0-9A-Z]{16}\b/, "AWS access key id"],
  [/\bgh[pousr]_[A-Za-z0-9]{36,}\b/, "GitHub token"],
  [/\bnpm_[A-Za-z0-9]{36}\b/, "npm token"],
  [/\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{32,}\b/, "API secret key"],
  [/\bxox[abpr]-[A-Za-z0-9-]{10,}\b/, "Slack token"],
];

/** Missing README/LICENSE, forbidden files, fixtures outside the policies package. */
export function fileListProblems(name: string, files: readonly string[]): string[] {
  const problems = REQUIRED_FILES.filter((f) => !files.includes(f)).map((f) => `missing ${f}`);
  for (const file of files) {
    for (const [pattern, what] of FORBIDDEN) {
      if (pattern.test(file)) problems.push(`${file}: ${what}`);
    }
    const isFixture = file.endsWith(".fixtures.json");
    if (isFixture && (name !== "@jev-cops/policies" || file.includes("/"))) {
      problems.push(`${file}: fixtures ship only as the policies' own *.fixtures.json`);
    }
  }
  return problems;
}

function repositoryProblems(m: Manifest, dir: string): string[] {
  const problems: string[] = [];
  if (m.repository?.url !== REPO_URL) problems.push(`repository.url must be ${REPO_URL}`);
  if (m.repository?.directory !== dir) problems.push(`repository.directory must be ${dir}`);
  for (const key of ["description", "homepage", "bugs", "author", "keywords"] as const) {
    if (m[key] === undefined) problems.push(`no ${key}`);
  }
  return problems;
}

function publishProblems(m: Manifest): string[] {
  const problems: string[] = [];
  if (m.private === true) problems.push("private: true");
  if (m.publishConfig?.provenance !== true) problems.push("publishConfig.provenance must be true");
  if (m.name.startsWith("@") && m.publishConfig?.access !== "public") {
    problems.push('publishConfig.access must be "public" for a scoped package');
  }
  return problems;
}

function dependencyProblems(m: Manifest, version: string, internal: ReadonlySet<string>): string[] {
  const problems: string[] = [];
  if (JSON.stringify(m).includes("workspace:")) problems.push("a workspace: range is left");
  for (const [dep, range] of Object.entries(m.dependencies ?? {})) {
    if (internal.has(dep) && range !== version) {
      problems.push(`dependency ${dep}@${range}: must be exactly ${version}`);
    }
  }
  return problems;
}

/** Name, lockstep version, engines, license, module type, metadata, publishConfig, dependencies. */
export function manifestProblems(input: TarballInput): string[] {
  const m = input.unpacked.manifest;
  const problems: string[] = [];
  if (m.name !== input.pkg.manifest.name)
    problems.push(`name ${m.name} ≠ ${input.pkg.manifest.name}`);
  if (m.version !== input.version) problems.push(`version ${m.version} ≠ ${input.version}`);
  if (m.engines?.bun !== BUN_ENGINE) problems.push(`engines.bun must be "${BUN_ENGINE}"`);
  if (m.license !== "Apache-2.0") problems.push("license must be Apache-2.0");
  if (m.type !== "module") problems.push('type must be "module"');
  if (m.files === undefined) problems.push("no files allow-list");
  return [
    ...problems,
    ...repositoryProblems(m, input.pkg.dir),
    ...publishProblems(m),
    ...dependencyProblems(m, input.version, input.internal),
  ];
}

/** Every string target of an `exports` map (conditions included). */
function exportTargets(exports: unknown): string[] {
  if (typeof exports === "string") return [exports];
  if (typeof exports !== "object" || exports === null) return [];
  return Object.values(exports).flatMap(exportTargets);
}

/** Bins, `main`, `types` and `exports` point at shipped files; bins start with the Bun shebang. */
export function entryProblems(unpacked: Unpacked): string[] {
  const m = unpacked.manifest;
  const shipped = (target: string) => unpacked.files.includes(normalize(target));
  const problems: string[] = [];
  const entries = [m.main, m.types, ...exportTargets(m.exports)].filter(
    (t): t is string => t !== undefined && !t.includes("*"),
  );
  for (const t of entries) if (!shipped(t)) problems.push(`entry ${t} is not in the tarball`);
  for (const [bin, target] of Object.entries(m.bin ?? {})) {
    if (!shipped(target)) {
      problems.push(`bin ${bin} → ${target} is not in the tarball`);
      continue;
    }
    const head = readFileSync(join(unpacked.root, normalize(target)), "utf8").split("\n")[0];
    if (head !== "#!/usr/bin/env bun")
      problems.push(`bin ${bin}: first line must be #!/usr/bin/env bun`);
  }
  return problems;
}

const transpiler = new Bun.Transpiler({ loader: "ts" });

/** The package a bare specifier names (`@scope/pkg/sub` → `@scope/pkg`). */
export function packageOf(specifier: string): string {
  const parts = specifier.split("/");
  return specifier.startsWith("@") ? parts.slice(0, 2).join("/") : (parts[0] ?? specifier);
}

function relativeTargetShipped(from: string, specifier: string, files: readonly string[]): boolean {
  const target = normalize(join(dirname(from), specifier));
  return [target, `${target}.ts`, join(target, "index.ts")].some((t) => files.includes(t));
}

/**
 * Runtime imports of every shipped module (Bun's own scanner: no comments, no type-only
 * imports): relative ones must be shipped, bare ones built in or declared, and only the
 * SDK's `bun:test` adapter may import `bun:test`.
 */
export function importProblems(unpacked: Unpacked): string[] {
  const m = unpacked.manifest;
  const declared = new Set([
    m.name,
    ...Object.keys(m.dependencies ?? {}),
    ...Object.keys(m.peerDependencies ?? {}),
    ...Object.keys(m.optionalDependencies ?? {}),
  ]);
  const problems: string[] = [];
  for (const file of unpacked.files.filter(
    (f) => /\.[cm]?[jt]s$/.test(f) && !f.endsWith(".d.ts"),
  )) {
    // The scanner rejects a shebang line; blank it (bins start with one).
    const source = readFileSync(join(unpacked.root, file), "utf8").replace(/^#!.*/, "");
    for (const { path } of transpiler.scanImports(source)) {
      if (path === "bun:test" && !(m.name === "@jev-cops/sdk" && file === "src/test.ts")) {
        problems.push(`${file}: imports bun:test`);
      } else if (path.startsWith(".")) {
        if (!relativeTargetShipped(file, path, unpacked.files)) {
          problems.push(`${file}: imports ${path}, which is not in the tarball`);
        }
      } else if (!path.startsWith("bun:") && path !== "bun" && !isBuiltin(path)) {
        if (!declared.has(packageOf(path))) problems.push(`${file}: imports undeclared ${path}`);
      }
    }
  }
  return problems;
}

/** Secret-looking tokens in any shipped text file. */
export function secretProblems(unpacked: Unpacked): string[] {
  return unpacked.files.flatMap((file) => {
    const text = readFileSync(join(unpacked.root, file), "utf8");
    return SECRETS.filter(([pattern]) => pattern.test(text)).map(([, what]) => `${file}: ${what}`);
  });
}

/** Every rule for one tarball; empty when it may be published. */
export function tarballProblems(input: TarballInput): string[] {
  const { unpacked } = input;
  const license = unpacked.files.includes("LICENSE")
    ? readFileSync(join(unpacked.root, "LICENSE"), "utf8")
    : input.license;
  return [
    ...fileListProblems(input.pkg.manifest.name, unpacked.files),
    ...manifestProblems(input),
    ...entryProblems(unpacked),
    ...importProblems(unpacked),
    ...secretProblems(unpacked),
    ...(license === input.license ? [] : ["LICENSE differs from the repository's"]),
  ];
}

/** One packed and checked package. */
export interface PackedPackage {
  readonly pkg: WorkspacePackage;
  readonly tgz: string;
  readonly unpacked: Unpacked;
  readonly problems: readonly string[];
}

/**
 * Packs every publishable package into `dest` in publish order and checks each tarball.
 * Throws when the workspace itself is inconsistent (publish order, versions).
 */
export async function packAll(dest: string, repo: string = REPO): Promise<PackedPackage[]> {
  const all = workspacePackages(repo);
  const orderProblems = [...publishOrderProblems(all), ...metaPackageProblems(all)];
  if (orderProblems.length > 0) throw new Error(orderProblems.join("\n"));
  const version = releaseVersion(all);
  const internal = new Set(all.map((p) => p.manifest.name));
  const license = readFileSync(join(repo, "LICENSE"), "utf8");
  const packed: PackedPackage[] = [];
  for (const pkg of publishable(all)) {
    const tgz = await pack(pkg, join(dest, "tarballs"), repo);
    const unpacked = await unpack(tgz, join(dest, "unpacked", pkg.manifest.name));
    const problems = tarballProblems({ pkg, unpacked, version, internal, license });
    packed.push({ pkg, tgz, unpacked, problems });
  }
  return packed;
}
