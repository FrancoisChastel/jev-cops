/**
 * The protection fragment (spec §OpenShell complement "Protection", PLAN-M2 §4 and D-107):
 * `filesystem_policy`, `landlock` and `process` for one harness layout, derived from
 * `config-tamper`'s trees (policies/_lib/config-trees.ts) rather than a second list.
 *
 * - The harness's own kill- and hold-tier config (tree roots and rules) is `read_only`: the
 *   harness reads it, nothing in the sandbox writes it (T1 at the kernel).
 * - Its annotate-tier rules and the data it must write ({@link HARNESS_WRITABLE}), the
 *   workspace and the baseline's writable paths are `read_write`; nothing else is.
 * - Every other harness's config and the judge's own `~/.jev-cops` are left unlisted, which
 *   Landlock makes inaccessible: "Paths that are not listed are inaccessible"
 *   (schema.mdx:48-49). Stronger than read-only, and it keeps D-098's records unreadable.
 * - The adapter's files (hook binary, Pi extension) sit in read-only directories.
 * - `landlock.compatibility: hard_requirement` (schema.mdx:75-78): a kernel that cannot
 *   enforce this set does not run the agent (PLAN-M2 §2 row 16).
 *
 * Refused: a layout whose writable roots contain a kill-tier path (Landlock grants, never
 * revokes), HOME inside the workspace, a private path listed at all, a bad path, more than
 * 256 paths. Printed as gaps: the harness's {@link KERNEL_GAPS} and project config under the
 * workspace.
 */
import { posix } from "node:path";
import { CONFIG_TREES, canon, treeEntries } from "../../../../policies/_lib/config-trees.ts";
import {
  adapterPaths,
  HARNESS_WRITABLE,
  type Harness,
  KERNEL_GAPS,
  type SandboxLayout,
} from "../layout.ts";
import { type Absent, type FragmentReport, isUnder, pathProblem } from "../types.ts";
import { privateCheck, tierWorld, writableCheck } from "./tiers.ts";

/** Read-only paths OpenShell adds when a policy has a network rule (default-policy.mdx:56-59). */
export const BASELINE_READ_ONLY: readonly string[] = Object.freeze([
  "/usr",
  "/lib",
  "/etc",
  "/app",
  "/var/log",
  "/proc",
  "/dev/urandom",
]);
/** Read-write baseline paths (default-policy.mdx:59). */
export const BASELINE_READ_WRITE: readonly string[] = Object.freeze(["/tmp", "/dev/null"]);
/** Combined `read_only` + `read_write` entries (schema.mdx:56). */
const MAX_PATHS = 256;

/** What the protection fragment is built from. */
export interface ProtectionInput {
  readonly harness: Harness;
  readonly layout: SandboxLayout;
  /** More kill-tier sandbox paths (the daemon's protected paths rewritten for the sandbox). */
  readonly protectedPaths: readonly string[];
  /** More paths that must stay unreadable, beside `~/.jev-cops`. */
  readonly privatePaths: readonly string[];
  /** Operator additions to `read_write`, checked like the rest. */
  readonly extraReadWrite: readonly string[];
}

/** The fragment: three policy sections plus its report. */
export interface ProtectionFragment extends FragmentReport {
  readonly filesystem: {
    readonly include_workdir: boolean;
    readonly read_only: string[];
    readonly read_write: string[];
  };
  readonly landlock: { readonly compatibility: "hard_requirement" };
  readonly process?: { readonly run_as_user: string; readonly run_as_group: string };
}

interface Lists {
  readonly readOnly: string[];
  readonly readWrite: string[];
  readonly absent: Absent[];
}

function ownTreeLists(harness: Harness, home: string): Lists {
  const entries = CONFIG_TREES.filter((t) => t.owner === harness).flatMap((t) =>
    treeEntries(t).map((e) => ({ ...e, anchor: t.anchor })),
  );
  const at = (e: { path: string; anchor: string }) =>
    e.anchor === "home" ? posix.join(home, e.path) : e.path;
  const literal = entries.filter((e) => e.anchor !== "project" && !e.path.includes("*"));
  const guarded = literal.filter((e) => e.tier === "kill" || e.tier === "hold");
  const onBaseline = (p: string) => BASELINE_READ_ONLY.some((root) => isUnder(p, root));
  const outside = guarded.filter((e) => e.anchor === "absolute" && !onBaseline(e.path));
  const wild = entries.filter((e) => e.anchor === "home" && e.path.includes("*"));
  return {
    readOnly: guarded.filter((e) => !outside.includes(e)).map(at),
    readWrite: literal.filter((e) => e.tier === "annotate").map(at),
    absent: [
      ...outside.map((e) => ({ path: e.path, why: "not a Linux path: unlisted, inaccessible" })),
      ...wild.map((e) => ({
        path: at(e),
        why: "wildcard rule: Landlock paths are literal; its nearest listed ancestor decides",
      })),
    ],
  };
}

function otherTreesAbsent(harness: Harness, home: string): Absent[] {
  const roots = CONFIG_TREES.filter((t) => t.owner !== harness && t.anchor === "home");
  const unique = [...new Map(roots.map((t) => [t.root, t])).values()];
  return unique.map((t) => ({
    path: posix.join(home, t.root),
    why:
      t.root === ".jev-cops"
        ? "the judge's private records and keys (D-098): unlisted, unreadable"
        : `${t.owner} configuration: unlisted, inaccessible`,
  }));
}

function lists(input: ProtectionInput): Lists {
  const { harness, layout } = input;
  const own = ownTreeLists(harness, layout.home);
  const writable = [
    layout.workspace,
    ...HARNESS_WRITABLE[harness].map((w) => posix.join(layout.home, w.path)),
    ...own.readWrite,
    ...BASELINE_READ_WRITE,
    ...input.extraReadWrite,
  ];
  const readWrite = [...new Set(writable)].sort();
  const adapterDirs = adapterPaths(layout).map((p) => posix.dirname(p));
  const readOnly = [...new Set([...BASELINE_READ_ONLY, ...own.readOnly, ...adapterDirs])]
    .filter((p) => !readWrite.includes(p))
    .sort();
  const absent = [...own.absent, ...otherTreesAbsent(harness, layout.home)];
  return { readOnly, readWrite, absent };
}

function layoutProblems(input: ProtectionInput): string[] {
  const { layout } = input;
  const paths = [
    layout.home,
    layout.workspace,
    ...adapterPaths(layout),
    ...input.protectedPaths,
    ...input.privatePaths,
    ...input.extraReadWrite,
  ];
  const bad = paths.map(pathProblem).filter((p): p is string => p !== null);
  const writable = [layout.workspace, ...input.extraReadWrite];
  const root = writable
    .filter((p) => p.replace(/\/+$/, "") === "")
    .map(() => "read_write cannot be /");
  return [...bad, ...root];
}

function homeInsideWorkspace(layout: SandboxLayout): string[] {
  return isUnder(canon(layout.home), canon(layout.workspace))
    ? [`HOME ${layout.home} is inside the read_write workspace ${layout.workspace} (D-107)`]
    : [];
}

function gapLines(harness: Harness, home: string, projectGaps: readonly string[]): string[] {
  const kernel = KERNEL_GAPS[harness].map(
    (rel) =>
      `${posix.join(home, rel)} stays writable (the harness rewrites it); config-tamper keeps it kill tier (D-107)`,
  );
  const project =
    projectGaps.length === 0
      ? []
      : [
          `project config under the workspace stays writable (Landlock cannot carve read-only paths out of a read_write tree): ${projectGaps.join(", ")}; config-tamper keeps it kill tier, and Claude Code's hook is installed managed under /etc/claude-code`,
        ];
  return [...kernel, ...project];
}

/** Builds the protection fragment for `input`; see the module comment. */
export function protectionFragment(input: ProtectionInput): ProtectionFragment {
  const { harness, layout } = input;
  const process =
    layout.runAs === null
      ? {}
      : { process: { run_as_user: layout.runAs.user, run_as_group: layout.runAs.group } };
  const base = { landlock: { compatibility: "hard_requirement" as const }, ...process };
  const problems = layoutProblems(input);
  const { readOnly, readWrite, absent } = lists(input);
  const filesystem = { include_workdir: false, read_only: readOnly, read_write: readWrite };
  if (problems.length > 0) return { ...base, filesystem, absent, gaps: [], refusals: problems };
  const world = tierWorld(layout.home, layout.workspace, [
    ...adapterPaths(layout),
    ...input.protectedPaths,
  ]);
  const gaps = new Set(KERNEL_GAPS[harness].map((rel) => canon(posix.join(layout.home, rel))));
  const writable = writableCheck(readWrite, world, gaps, layout.workspace);
  const privatePaths = [posix.join(layout.home, ".jev-cops"), ...input.privatePaths];
  const count = readOnly.length + readWrite.length;
  const refusals = [
    ...homeInsideWorkspace(layout),
    ...writable.refusals,
    ...privateCheck([...readOnly, ...readWrite], privatePaths),
    ...(count > MAX_PATHS
      ? [`the policy would list ${count} paths; OpenShell allows ${MAX_PATHS}`]
      : []),
  ];
  return {
    ...base,
    filesystem,
    absent,
    gaps: gapLines(harness, layout.home, writable.projectGaps),
    refusals,
  };
}
