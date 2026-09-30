/**
 * The release logic behind `scripts/release.ts`: arguments, the plan (publish order, skip
 * what the registry already has) and the run, with everything outside the process
 * (packing, the registry, npm) injected. See RELEASING.md.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PackedPackage } from "./pack-lib.ts";

/** What one run does. */
export interface ReleaseOptions {
  readonly publish: boolean;
  readonly tag: string;
}

/** A dist-tag npm accepts and that cannot be read as a version or a range. */
const TAG = /^[a-z][a-z0-9-]{0,31}$/;

/** `--publish` or `--dry-run` (the default), `--tag <name>` (default `latest`). */
export function parseReleaseArgs(argv: readonly string[]): ReleaseOptions | string {
  let publish = false;
  let dryRun = false;
  let tag = "latest";
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--publish") publish = true;
    else if (arg === "--dry-run") dryRun = true;
    else if (arg === "--tag") {
      tag = argv[i + 1] ?? "";
      i += 1;
    } else return `unknown argument ${arg}`;
  }
  if (publish && dryRun) return "--publish and --dry-run are exclusive";
  if (!TAG.test(tag)) return `invalid dist-tag "${tag}" (lower case letters, digits, dashes)`;
  return { publish, tag };
}

/** The npm command that publishes (or dry-runs) one packed tarball. */
export function publishArgv(tgz: string, opts: ReleaseOptions): string[] {
  const argv = ["npm", "publish", tgz, "--access", "public", "--tag", opts.tag];
  return opts.publish ? argv : [...argv, "--dry-run"];
}

/** The steps of a release, in order: skip what the registry has, publish the rest. */
export function releasePlan(
  packed: readonly PackedPackage[],
  published: ReadonlySet<string>,
  opts: ReleaseOptions,
): { readonly label: string; readonly argv: readonly string[] | null }[] {
  return packed.map((p) => {
    const id = `${p.unpacked.manifest.name}@${p.unpacked.manifest.version}`;
    return published.has(id)
      ? { label: `${id}: already on the registry, skipped`, argv: null }
      : { label: `${id}: ${opts.publish ? "publish" : "dry run"}`, argv: publishArgv(p.tgz, opts) };
  });
}

/** What a release reaches outside itself. */
export interface ReleaseDeps {
  /** Packs and checks every package into `dir`, in publish order. */
  readonly pack: (dir: string) => Promise<PackedPackage[]>;
  /** Whether `name@version` is already on the registry. */
  readonly onRegistry: (id: string) => Promise<boolean>;
  readonly exec: (argv: readonly string[]) => Promise<number>;
  readonly out: (line: string) => void;
  readonly err: (line: string) => void;
}

/** Runs a release; resolves with the exit code (0 done, 1 a check or a publish failed, 2 usage). */
export async function runRelease(argv: readonly string[], deps: ReleaseDeps): Promise<number> {
  const opts = parseReleaseArgs(argv);
  if (typeof opts === "string") {
    deps.err(`release: ${opts}`);
    return 2;
  }
  const dir = mkdtempSync(join(tmpdir(), "jev-cops-release-"));
  try {
    const packed = await deps.pack(dir);
    const bad = packed.filter((p) => p.problems.length > 0);
    for (const p of bad) deps.err(`${p.pkg.manifest.name}: ${p.problems.join("; ")}`);
    if (bad.length > 0) return 1;
    const published = new Set<string>();
    for (const p of packed) {
      const id = `${p.unpacked.manifest.name}@${p.unpacked.manifest.version}`;
      if (await deps.onRegistry(id)) published.add(id);
    }
    for (const step of releasePlan(packed, published, opts)) {
      deps.out(`== ${step.label}`);
      if (step.argv !== null && (await deps.exec(step.argv)) !== 0) return 1;
    }
    deps.out(`release: ${opts.publish ? "published" : "dry run done"} (${opts.tag})`);
    return 0;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
