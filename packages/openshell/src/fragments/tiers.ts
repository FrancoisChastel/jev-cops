/**
 * `config-tamper`'s tiers (policies/_lib/config-trees.ts, D-073) placed in the sandbox:
 * the kill-tier paths the protection fragment must keep out of every writable tree.
 * Landlock "grants access to a file path if at least one of its rules encountered on the
 * path grants the access" (landlock.rst, §Layers of file path access rights), so a
 * `read_only` entry under a `read_write` ancestor is writable (PLAN-M2 §2 row 2): the only
 * protection is that no writable root contains a kill-tier path.
 */
import { posix } from "node:path";
import {
  CONFIG_TREES,
  type ConfigTree,
  canon,
  type PlacedTree,
  pathTier,
  placeTrees,
  projectRoots,
  treeEntries,
} from "@jev-cops/policies/_lib/config-trees";
import { isUnder } from "../types.ts";

/** A concrete kill-tier path in the sandbox. */
export interface KillPath {
  readonly path: string;
  /** Anchored at a project root (the workspace or above): writable by design under OpenShell. */
  readonly project: boolean;
}

/** The trees placed for one layout, and every kill-tier path they name. */
export interface TierWorld {
  readonly placed: readonly PlacedTree[];
  readonly kills: readonly KillPath[];
}

/** A tree-relative path cut before its first wildcard segment (Landlock paths are literal). */
function literalPrefix(rel: string): string {
  const segs = rel.split("/");
  const wild = segs.findIndex((s) => s.includes("*"));
  return wild === -1 ? rel : segs.slice(0, wild).join("/");
}

function basesOf(tree: ConfigTree, home: string, roots: readonly string[]): readonly string[] {
  if (tree.anchor === "home") return [home];
  return tree.anchor === "project" ? roots : ["/"];
}

function killsOf(tree: ConfigTree, home: string, roots: readonly string[]): KillPath[] {
  const rels = treeEntries(tree)
    .filter((e) => e.tier === "kill")
    .map((e) => literalPrefix(e.path));
  return basesOf(tree, home, roots).flatMap((base) =>
    rels.map((rel) => ({
      path: rel.startsWith("/") ? rel : posix.join(base, rel),
      project: tree.anchor === "project",
    })),
  );
}

/** Places every tree for `home` and `workspace`, plus `protectedPaths` as kill tier. */
export function tierWorld(
  home: string,
  workspace: string,
  protectedPaths: readonly string[],
): TierWorld {
  const roots = projectRoots(workspace, workspace, home);
  const placed = placeTrees({ home, projectRoots: roots, protectedPaths });
  const kills = [
    ...CONFIG_TREES.flatMap((t) => killsOf(t, home, roots)),
    ...protectedPaths.map((path) => ({ path, project: false })),
  ];
  return { placed, kills };
}

/** What the writable roots leave writable that config-tamper calls kill tier. */
export interface WritableCheck {
  readonly refusals: string[];
  /** Project config under the workspace: writable by construction (printed gap). */
  readonly projectGaps: string[];
}

function refusalsFor(
  root: string,
  world: TierWorld,
  gaps: ReadonlySet<string>,
  workspace: string,
): WritableCheck {
  const r = canon(root);
  const refusals: string[] = [];
  const projectGaps: string[] = [];
  if (pathTier(root, world.placed) === "kill" && !gaps.has(r)) {
    refusals.push(`${root} is kill tier (config-tamper) and cannot be listed read_write`);
  }
  for (const k of world.kills) {
    const p = canon(k.path);
    if (p === r || !isUnder(p, r) || gaps.has(p)) continue;
    if (k.project && isUnder(p, canon(workspace))) projectGaps.push(k.path);
    else {
      refusals.push(
        `kill-tier ${k.path} sits under read_write ${root}: Landlock grants, never revokes, so read_only cannot protect it (D-106, D-107)`,
      );
    }
  }
  return { refusals, projectGaps };
}

/**
 * Refuses every `read_write` root that is kill tier itself or contains a kill-tier path,
 * except the harness's documented kernel gaps (`gaps`, canonical) and project config under
 * the workspace (returned as gaps: a repository's `.claude/settings.json` cannot be carved
 * out of a writable checkout).
 */
export function writableCheck(
  readWrite: readonly string[],
  world: TierWorld,
  gaps: ReadonlySet<string>,
  workspace: string,
): WritableCheck {
  const each = readWrite.map((root) => refusalsFor(root, world, gaps, workspace));
  return {
    refusals: [...new Set(each.flatMap((c) => c.refusals))],
    projectGaps: [...new Set(each.flatMap((c) => c.projectGaps))].sort(),
  };
}

/** Refuses a listed path that contains, or lies inside, a private path (D-098). */
export function privateCheck(listed: readonly string[], privatePaths: readonly string[]): string[] {
  return privatePaths.flatMap((priv) =>
    listed
      .filter((p) => isUnder(canon(p), canon(priv)) || isUnder(canon(priv), canon(p)))
      .map((p) => `private ${priv} would be readable through ${p} (D-098): list neither`),
  );
}
