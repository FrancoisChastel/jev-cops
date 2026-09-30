/**
 * The harness and judge configuration trees behind `config-tamper` (D-073), shared with the
 * OpenShell compiler's protection fragment (PLAN-M2 §4, D-107) so both read the same lists.
 * Pure: no imports, no I/O, no event types.
 *
 * A tree is a root under an anchor (`home`: the daemon's `~`; `project`: the cwd, the repo
 * root and every directory above them, never home; `absolute`), the tier of anything in it
 * (`rest`) and refinements below it (`rules`, relative, `*` matching one segment). Tiers:
 * - kill: files that control hooks, permissions or extensions — Claude Code
 *   `settings.json`/`settings.local.json` (user and project), `~/.claude.json`, the
 *   managed-settings dirs, `hooks/`, `~/.claude/plugins/`; Codex `~/.codex/{config.toml,
 *   hooks.json,rules}` and a project's `.codex/`; OpenCode `plugin(s)/` dirs and
 *   `opencode.json[c]`; Pi `extensions/` and `settings.json`; jev-cops's
 *   `~/.config/jev-cops/`, `~/.jev-cops/`, `.cops.toml`, and the daemon's protected paths;
 * - hold: everything else under a harness config dir (instructions, skills, agents,
 *   commands, output styles) and a project's `.mcp.json`;
 * - annotate: data the harness has the model write by design (`~/.claude/projects/*
 *   /memory/`, `~/.claude/plans/`, `~/.claude/todos/`);
 * - ignore (rules only): a Claude Code worktree under `.claude/worktrees/`.
 *
 * Matching is case-insensitive on absolute paths with backslashes turned into slashes
 * ({@link canon}). A directory that contains a kill rule is itself kill (deleting or
 * replacing `~/.claude` removes `settings.json`). A directory above a placed tree's root
 * (home, `/`, `~/.config`, a repo root, `/etc`) is in no tree ({@link pathTier} is null) but
 * takes the highest tier of the trees below it ({@link ancestorTier}); which accesses to it
 * count is the caller's to say.
 */

/** How much a change to a path matters, lowest first. */
export type Tier = "annotate" | "hold" | "kill";
/** A rule's tier; `ignore` takes the subtree out of its tree entirely. */
export type RuleTier = Tier | "ignore";
/** What a tree's root is relative to. */
export type Anchor = "home" | "project" | "absolute";
/** Whose configuration a tree is. */
export type TreeOwner = "claude-code" | "codex" | "opencode" | "pi" | "jev-cops";
/** Tiers below a tree's root, keyed by relative path (`*` matches one segment). */
export type TierRules = Readonly<Record<string, RuleTier>>;

/** One configuration tree: `root` under `anchor`, `rest` for anything in it, `rules` below. */
export interface ConfigTree {
  readonly owner: TreeOwner;
  readonly anchor: Anchor;
  /** Relative to the anchor (`home`, `project`), or absolute and lower-case (`absolute`). */
  readonly root: string;
  readonly rest: Tier;
  readonly rules?: TierRules;
}

/** A tree's root or one of its rules, as a path relative to the tree's anchor. */
export interface TreeEntry {
  readonly path: string;
  readonly tier: RuleTier;
}

/** A rule of a placed tree, split into lower-case segments. */
export interface PlacedRule {
  readonly segs: readonly string[];
  readonly tier: RuleTier;
}

/** A tree at one concrete base directory: `base` is canonical ({@link canon}). */
export interface PlacedTree {
  readonly base: string;
  readonly rest: Tier;
  readonly rules: readonly PlacedRule[];
}

/** Where the trees of one call are placed. */
export interface TreeRoots {
  /** `~`: the daemon's home (`ctx.config.home`), or the sandbox HOME for the compiler. */
  readonly home: string;
  /** Canonical directories a project's config can live in ({@link projectRoots}). */
  readonly projectRoots: readonly string[];
  /** Extra kill-tier paths (`ctx.config.protectedPaths`): absolute, or project-relative. */
  readonly protectedPaths: readonly string[];
}

const CLAUDE_KILL: TierRules = {
  "settings.json": "kill",
  "settings.local.json": "kill",
  hooks: "kill",
};
/** Claude Code data the model writes by design under `~/.claude/`. */
const HARNESS_DATA: TierRules = {
  "projects/*/memory": "annotate",
  plans: "annotate",
  todos: "annotate",
};

function frozen(trees: readonly ConfigTree[]): readonly ConfigTree[] {
  const one = (t: ConfigTree): ConfigTree =>
    Object.freeze(
      t.rules === undefined ? { ...t } : { ...t, rules: Object.freeze({ ...t.rules }) },
    );
  return Object.freeze(trees.map(one));
}

/** Every harness and judge configuration tree, in matching order (frozen). */
export const CONFIG_TREES: readonly ConfigTree[] = frozen([
  {
    owner: "claude-code",
    anchor: "home",
    root: ".claude",
    rest: "hold",
    rules: { ...CLAUDE_KILL, plugins: "kill", ...HARNESS_DATA },
  },
  { owner: "claude-code", anchor: "home", root: ".claude.json", rest: "kill" },
  {
    owner: "codex",
    anchor: "home",
    root: ".codex",
    rest: "hold",
    rules: { "config.toml": "kill", "hooks.json": "kill", rules: "kill" },
  },
  {
    owner: "opencode",
    anchor: "home",
    root: ".config/opencode",
    rest: "hold",
    rules: { plugin: "kill", plugins: "kill", "opencode.json": "kill", "opencode.jsonc": "kill" },
  },
  {
    owner: "pi",
    anchor: "home",
    root: ".pi",
    rest: "hold",
    rules: { "agent/extensions": "kill", "agent/settings.json": "kill" },
  },
  { owner: "jev-cops", anchor: "home", root: ".config/jev-cops", rest: "kill" },
  { owner: "jev-cops", anchor: "home", root: ".jev-cops", rest: "kill" },
  {
    owner: "claude-code",
    anchor: "project",
    root: ".claude",
    rest: "hold",
    rules: { ...CLAUDE_KILL, worktrees: "ignore" },
  },
  { owner: "codex", anchor: "project", root: ".codex", rest: "kill" },
  {
    owner: "opencode",
    anchor: "project",
    root: ".opencode",
    rest: "hold",
    rules: { plugin: "kill", plugins: "kill" },
  },
  { owner: "opencode", anchor: "project", root: "opencode.json", rest: "kill" },
  { owner: "opencode", anchor: "project", root: "opencode.jsonc", rest: "kill" },
  {
    owner: "pi",
    anchor: "project",
    root: ".pi",
    rest: "hold",
    rules: { extensions: "kill", "settings.json": "kill" },
  },
  { owner: "jev-cops", anchor: "project", root: ".cops.toml", rest: "kill" },
  { owner: "claude-code", anchor: "project", root: ".mcp.json", rest: "hold" },
  {
    owner: "claude-code",
    anchor: "absolute",
    root: "/library/application support/claudecode",
    rest: "kill",
  },
  { owner: "claude-code", anchor: "absolute", root: "/etc/claude-code", rest: "kill" },
  { owner: "claude-code", anchor: "absolute", root: "/c/program files/claudecode", rest: "kill" },
]);

/** Claude Code's Windows managed-settings dir, kill wherever it appears in a path. */
export const WINDOWS_MANAGED = "c:/program files/claudecode";

/** Tier order: a higher rank wins. */
export const TIER_RANK: Readonly<Record<Tier, number>> = Object.freeze({
  annotate: 0,
  hold: 1,
  kill: 2,
});

/** The form paths are matched in: slashes only, lower-case, no trailing slash (but `/`). */
export function canon(path: string): string {
  const slashed = path.replaceAll("\\", "/").toLowerCase();
  return slashed.length > 1 ? slashed.replace(/\/+$/, "") : slashed;
}

function segs(path: string): string[] {
  return path.split("/").filter((s) => s !== "");
}

function join(base: string, rel: string): string {
  return rel.startsWith("/") ? rel : `${base === "/" ? "" : base}/${rel}`;
}

/** `path` (canonical) and every directory above it; nothing for a relative path. */
function ancestors(path: string): string[] {
  const out: string[] = [];
  for (let p = canon(path); p.startsWith("/"); p = p.slice(0, p.lastIndexOf("/")) || "/") {
    out.push(p);
    if (p === "/") break;
  }
  return out;
}

/**
 * Where a project's harness config can live for a call: the cwd, the repo root and every
 * directory above either (the harness's project dir is one of them), never `home` itself.
 * Canonical, deduplicated, cwd's line first.
 */
export function projectRoots(cwd: string, repo: string | null | undefined, home: string): string[] {
  const roots = [...ancestors(cwd), ...ancestors(repo ?? "")];
  return [...new Set(roots)].filter((r) => r !== canon(home));
}

/** A tree's root and rules as entries relative to its anchor, root first. */
export function treeEntries(tree: ConfigTree): TreeEntry[] {
  const rules = Object.entries(tree.rules ?? {}).map(([rel, tier]) => ({
    path: `${tree.root}/${rel}`,
    tier,
  }));
  return [{ path: tree.root, tier: tree.rest }, ...rules];
}

function place(tree: ConfigTree, base: string): PlacedTree {
  const rules = Object.entries(tree.rules ?? {}).map(([rel, tier]) => ({ segs: segs(rel), tier }));
  return { base: canon(join(base, tree.root)), rest: tree.rest, rules };
}

/**
 * Every tree at every base for one call: home trees under `home`, project trees under each
 * project root, absolute ones as they are, plus each protected path as a kill tree
 * (absolute, or under each project root when relative). Build once per call, then ask
 * {@link pathTier} (or {@link ancestorTier}) per path.
 */
export function placeTrees(roots: TreeRoots): PlacedTree[] {
  const home = canon(roots.home);
  const extra: ConfigTree[] = roots.protectedPaths.map((root) => ({
    owner: "jev-cops",
    anchor: root.startsWith("/") ? "absolute" : "project",
    root: canon(root),
    rest: "kill",
  }));
  const basesOf = (a: Anchor): readonly string[] =>
    a === "home" ? [home] : a === "project" ? roots.projectRoots : ["/"];
  return [...CONFIG_TREES, ...extra].flatMap((t) => basesOf(t.anchor).map((b) => place(t, b)));
}

function prefixOf(pattern: readonly string[], rel: readonly string[]): boolean {
  return pattern.length <= rel.length && pattern.every((s, i) => s === "*" || s === rel[i]);
}

/** The tier of `rel` inside a placed tree: the most specific rule, a dir holding a kill rule, or the rest. */
function tierIn(tree: PlacedTree, rel: readonly string[]): Tier | null {
  const hits = tree.rules.filter((r) => prefixOf(r.segs, rel));
  const best = hits.toSorted((a, b) => b.segs.length - a.segs.length)[0];
  if (best !== undefined) return best.tier === "ignore" ? null : best.tier;
  const holdsKill = tree.rules.some((r) => r.tier === "kill" && prefixOf(rel, r.segs));
  return holdsKill ? "kill" : tree.rest;
}

/** The highest of `tiers` by {@link TIER_RANK}; null when every one is null. */
export function maxTier(tiers: readonly (Tier | null)[]): Tier | null {
  return tiers.reduce<Tier | null>(
    (m, t) => (t !== null && (m === null || TIER_RANK[t] > TIER_RANK[m]) ? t : m),
    null,
  );
}

/**
 * The highest tier any placed tree gives `path` (absolute), or null when no tree covers it
 * or an `ignore` rule takes it out. A path containing {@link WINDOWS_MANAGED} is kill.
 */
export function pathTier(path: string, trees: readonly PlacedTree[]): Tier | null {
  const p = canon(path);
  if (p.includes(WINDOWS_MANAGED)) return "kill";
  const tiers = trees.map((t) => {
    if (p !== t.base && !p.startsWith(`${t.base}/`)) return null;
    return tierIn(t, segs(p.slice(t.base.length)));
  });
  return maxTier(tiers);
}

/** The directories above {@link WINDOWS_MANAGED}: `c:` and `c:/program files`. */
const WINDOWS_ABOVE: readonly string[] = segs(WINDOWS_MANAGED)
  .slice(0, -1)
  .map((_, i, above) => above.slice(0, i + 1).join("/"));

/** The highest tier anywhere in a placed tree: its rest or a rule's (`ignore` is none). */
function treeTier(tree: PlacedTree): Tier | null {
  return maxTier([tree.rest, ...tree.rules.map((r) => (r.tier === "ignore" ? null : r.tier))]);
}

/**
 * The tier a directory takes from the trees below it: the highest tier of every placed tree
 * whose root sits strictly under `path` (absolute), or null when none does. Home, `/`,
 * `~/.config` and a repo root are kill; a tree's own root is not its ancestor (its tier is
 * {@link pathTier}'s). A directory above {@link WINDOWS_MANAGED} (`c:`, `c:/program files`,
 * wherever it appears in a path) is kill.
 */
export function ancestorTier(path: string, trees: readonly PlacedTree[]): Tier | null {
  const p = canon(path);
  if (WINDOWS_ABOVE.some((w) => p === w || p.endsWith(`/${w}`))) return "kill";
  const under = p === "/" ? "/" : `${p}/`;
  return maxTier(trees.filter((t) => t.base.startsWith(under)).map(treeTier));
}

/** Kill-tier paths of {@link CONFIG_TREES} as code names them: relative to the anchor. */
const TREE_KILL_MARKERS: readonly string[] = CONFIG_TREES.flatMap((t) =>
  treeEntries(t)
    .filter((entry) => entry.tier === "kill")
    .map((entry) => entry.path),
);

/**
 * Kill-tier paths as they can appear in code (`.claude/settings.json`, `.claude.json`,
 * `/etc/claude-code`), then {@link WINDOWS_MANAGED}, then each protected path, canonical.
 * `config-tamper` holds opaque code whose text contains one; the first match names it.
 */
export function killMarkers(protectedPaths: readonly string[]): string[] {
  return [...TREE_KILL_MARKERS, WINDOWS_MANAGED, ...protectedPaths.map(canon)];
}
