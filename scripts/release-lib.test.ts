import { describe, expect, test } from "bun:test";
import type { PackedPackage } from "./pack-lib.ts";
import {
  parseReleaseArgs,
  publishArgv,
  type ReleaseDeps,
  releasePlan,
  runRelease,
} from "./release-lib.ts";

describe("release arguments", () => {
  test("a dry run on latest unless --publish is given", () => {
    expect(parseReleaseArgs([])).toEqual({ publish: false, tag: "latest" });
    expect(parseReleaseArgs(["--dry-run", "--tag", "next"])).toEqual({
      publish: false,
      tag: "next",
    });
    expect(parseReleaseArgs(["--publish", "--tag", "beta"])).toEqual({
      publish: true,
      tag: "beta",
    });
  });

  test.each([
    [["--publish", "--dry-run"], "exclusive"],
    [["--tag"], 'invalid dist-tag ""'],
    [["--tag", "1.0.0"], "invalid dist-tag"],
    [["--tag", "Latest; rm -rf /"], "invalid dist-tag"],
    [["--yes"], "unknown argument --yes"],
  ])("%j is refused", (argv, message) => {
    expect(parseReleaseArgs(argv)).toContain(message);
  });
});

describe("release plan", () => {
  const pkg = (name: string): PackedPackage => ({
    pkg: { dir: `packages/${name}`, manifest: { name, version: "0.1.0" } },
    tgz: `/t/${name}.tgz`,
    unpacked: { root: "/u", files: [], manifest: { name, version: "0.1.0" } },
    problems: [],
  });

  test("npm publish of each tarball, public, tagged; --dry-run unless publishing", () => {
    expect(publishArgv("/t/a.tgz", { publish: false, tag: "latest" })).toEqual([
      "npm",
      "publish",
      "/t/a.tgz",
      "--access",
      "public",
      "--tag",
      "latest",
      "--dry-run",
    ]);
    expect(publishArgv("/t/a.tgz", { publish: true, tag: "next" })).not.toContain("--dry-run");
  });

  test("in order, skipping versions the registry already has (a halted release resumes)", () => {
    const plan = releasePlan(
      [pkg("@jev-cops/core"), pkg("@jev-cops/sdk"), pkg("jev-cops")],
      new Set(["@jev-cops/core@0.1.0"]),
      { publish: true, tag: "latest" },
    );
    expect(plan.map((s) => s.label)).toEqual([
      "@jev-cops/core@0.1.0: already on the registry, skipped",
      "@jev-cops/sdk@0.1.0: publish",
      "jev-cops@0.1.0: publish",
    ]);
    expect(plan[0]?.argv).toBeNull();
    expect(plan[1]?.argv).toContain("/t/@jev-cops/sdk.tgz");
    expect(releasePlan([pkg("x")], new Set(), { publish: false, tag: "latest" })[0]?.label).toBe(
      "x@0.1.0: dry run",
    );
  });
});

describe("runRelease", () => {
  const packed = (name: string, problems: string[] = []): PackedPackage => ({
    pkg: { dir: `packages/${name}`, manifest: { name, version: "0.1.0" } },
    tgz: `/t/${name}.tgz`,
    unpacked: { root: "/u", files: [], manifest: { name, version: "0.1.0" } },
    problems,
  });

  function fakes(pkgs: PackedPackage[], opts: { onRegistry?: string[]; failOn?: string } = {}) {
    const ran: string[][] = [];
    const out: string[] = [];
    const err: string[] = [];
    const deps: ReleaseDeps = {
      pack: async () => pkgs,
      onRegistry: async (id) => (opts.onRegistry ?? []).includes(id),
      exec: async (argv) => {
        ran.push([...argv]);
        return argv.includes(opts.failOn ?? "-") ? 1 : 0;
      },
      out: (l) => out.push(l),
      err: (l) => err.push(l),
    };
    return { deps, ran, out, err };
  }

  test("a dry run runs every npm publish --dry-run in order and skips what is published", async () => {
    const f = fakes([packed("a"), packed("b"), packed("c")], { onRegistry: ["a@0.1.0"] });
    expect(await runRelease([], f.deps)).toBe(0);
    expect(f.ran.map((a) => a[2])).toEqual(["/t/b.tgz", "/t/c.tgz"]);
    expect(f.ran.every((a) => a.includes("--dry-run"))).toBe(true);
    expect(f.out.at(-1)).toBe("release: dry run done (latest)");
  });

  test("a tarball with a problem stops the release before anything is published", async () => {
    const f = fakes([packed("a"), packed("b", ["missing LICENSE"])]);
    expect(await runRelease(["--publish"], f.deps)).toBe(1);
    expect(f.ran).toEqual([]);
    expect(f.err).toEqual(["b: missing LICENSE"]);
  });

  test("a failed publish stops the packages after it", async () => {
    const f = fakes([packed("a"), packed("b"), packed("c")], { failOn: "/t/b.tgz" });
    expect(await runRelease(["--publish", "--tag", "next"], f.deps)).toBe(1);
    expect(f.ran.map((a) => a[2])).toEqual(["/t/a.tgz", "/t/b.tgz"]);
    expect(f.ran[0]).not.toContain("--dry-run");
  });

  test("a usage error exits 2 and packs nothing", async () => {
    const f = fakes([packed("a")]);
    expect(await runRelease(["--tag", "1.0"], f.deps)).toBe(2);
    expect(f.err[0]).toContain("invalid dist-tag");
  });
});
